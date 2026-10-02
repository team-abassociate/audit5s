import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type * as PdfjsModule from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/**
 * PDF.js, loaded the first time anyone opens a preview and never before. It is the largest
 * thing on this page and most sessions never open one.
 *
 * The worker is a file this application serves itself, so the page's `script-src 'self'`
 * policy covers it, and the PDF reaches it as bytes already in memory — PDF.js makes no
 * request of its own.
 */
let pdfjs: Promise<typeof PdfjsModule> | null = null;
function loadPdfjs() {
  pdfjs ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/**
 * Fit the panel's width, fit one whole page, or a fixed scale where `1` is 100% — the
 * page at its printed size, an A4 sheet 794 CSS pixels wide, as every PDF viewer counts it.
 */
export type PdfZoom = 'width' | 'page' | number;

/** PDF points are 1/72 in; CSS pixels are 1/96 in. */
const CSS_PER_PT = 96 / 72;
/** The largest canvas side drawn: a page at 300% on a dense screen would otherwise be a
 * canvas of tens of megabytes, per page. */
const MAX_CANVAS_SIDE = 4096;

export interface PdfViewerHandle {
  goTo: (page: number) => void;
}

/** A4 portrait in points, until the document says otherwise. Every report is set on A4. */
const A4 = { width: 595.28, height: 841.89 };
const GAP = 14;

/**
 * The pages of one PDF, stacked and scrolled.
 *
 * Every page is laid out at its final size before it is drawn — from the page count the
 * history already knows, before the bytes even arrive — so nothing moves when the drawing
 * lands, and a page is drawn only when it is near the viewport. One viewer shows one report
 * (the panel keys it by snapshot), so another report always starts at the top.
 */
export const PdfViewer = forwardRef<
  PdfViewerHandle,
  {
    bytes: ArrayBuffer | null;
    pageCountHint: number;
    zoom: PdfZoom;
    onPage: (page: number) => void;
    /** The scale actually shown, `1` = 100% — a fit mode reports what it works out to. */
    onScale: (scale: number) => void;
    onPageCount: (count: number) => void;
    onError: (error: unknown) => void;
  }
>(function PdfViewer({ bytes, pageCountHint, zoom, onPage, onScale, onPageCount, onError }, ref) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [base, setBase] = useState(A4);
  const current = useRef(1);

  // The latest callbacks, without re-running the load whenever a parent re-renders.
  const callbacks = useRef({ onPageCount, onError });
  callbacks.current = { onPageCount, onError };

  useEffect(() => {
    setDoc(null);
    if (!bytes) return;
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;

    void loadPdfjs()
      .then(async (lib) => {
        if (cancelled) return;
        // PDF.js transfers the buffer to its worker, which empties it here. A copy keeps the
        // cached bytes whole for Download and for the next time this report is opened.
        const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
        destroy = () => task.destroy();
        const loaded = await task.promise;
        const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setBase({ width: first.width, height: first.height });
        setDoc(loaded);
        callbacks.current.onPageCount(loaded.numPages);
      })
      .catch((error: unknown) => {
        if (!cancelled) callbacks.current.onError(error);
      });

    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [bytes]);

  useLayoutEffect(() => {
    if (!scroller) return;
    // Measured once now rather than waiting for the observer's first report, which a
    // background tab does not deliver until it is shown again.
    const style = getComputedStyle(scroller);
    setSize({
      width: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  const count = doc?.numPages ?? Math.max(1, pageCountHint);
  // `size` is the content box: the scroller's own padding is already outside it.
  const ratio = base.height / base.width;
  const actualWidth = base.width * CSS_PER_PT;
  const room = Math.max(0, size.width);
  const pageWidth = Math.floor(
    zoom === 'width'
      ? room
      : zoom === 'page'
        ? Math.min(room, Math.max(0, size.height) / ratio)
        : actualWidth * zoom,
  );
  const pageHeight = Math.floor(pageWidth * ratio);
  const stride = pageHeight + GAP;

  useEffect(() => {
    if (pageWidth > 0) onScale(pageWidth / actualWidth);
  }, [pageWidth, actualWidth, onScale]);

  const goTo = (page: number) => {
    if (!scroller || stride <= GAP) return;
    const target = Math.min(Math.max(1, page), count);
    scroller.scrollTop = (target - 1) * stride;
    current.current = target;
    onPage(target);
  };
  useImperativeHandle(ref, () => ({ goTo }));

  // A zoom change or a resize keeps the page being read in view, rather than leaving the
  // reader somewhere in the middle of another.
  useLayoutEffect(() => {
    if (!doc || stride <= GAP || !scroller) return;
    goTo(current.current);
    // A page wider than the panel opens on its middle, the way it is centred when it fits.
    scroller.scrollLeft = Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2);
  }, [doc, stride]);

  const onScroll = () => {
    // Placeholders standing in for the document are not a page anyone is reading.
    if (!doc || !scroller || stride <= GAP) return;
    // The page under the upper third of the view is the one being read.
    const page = Math.floor((scroller.scrollTop + scroller.clientHeight / 3) / stride) + 1;
    const clamped = Math.min(Math.max(1, page), count);
    if (clamped !== current.current) {
      current.current = clamped;
      onPage(clamped);
    }
  };

  return (
    <div
      ref={setScroller}
      className="gb-pdf-pages"
      onScroll={onScroll}
      tabIndex={0}
      aria-label="Report pages"
      aria-busy={!doc}
    >
      {pageWidth > 0 &&
        Array.from({ length: count }, (_, index) => (
          <PdfPage
            key={index}
            doc={doc}
            number={index + 1}
            width={pageWidth}
            height={pageHeight}
            root={scroller}
          />
        ))}
    </div>
  );
});

function PdfPage({
  doc,
  number,
  width,
  height,
  root,
}: {
  doc: PDFDocumentProxy | null;
  number: number;
  width: number;
  height: number;
  root: HTMLElement | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const drawnRef = useRef(false);

  useEffect(() => {
    drawnRef.current = false;
    setDrawn(false);
  }, [doc]);

  useEffect(() => {
    if (!holder.current || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      root,
      rootMargin: '150% 0px',
    });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!doc || !near || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;

    // A resize redraws once it settles; the first drawing does not wait.
    const timer = setTimeout(
      async () => {
        try {
          const page = await doc.getPage(number);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const density = Math.min(window.devicePixelRatio || 1, 2, MAX_CANVAS_SIDE / width);
          const viewport = page.getViewport({ scale: (width / base.width) * density });
          // Drawn off screen and copied in, so a redraw at a new size never shows a blank page.
          const scratch = document.createElement('canvas');
          scratch.width = Math.floor(viewport.width);
          scratch.height = Math.floor(viewport.height);
          task = page.render({ canvas: scratch, viewport });
          await task.promise;
          const target = canvas.current;
          if (cancelled || !target) return;
          target.width = scratch.width;
          target.height = scratch.height;
          target.getContext('2d')?.drawImage(scratch, 0, 0);
          drawnRef.current = true;
          setDrawn(true);
        } catch {
          // Cancelled by a newer drawing, or the document closed underneath it.
        }
      },
      drawnRef.current ? 140 : 0,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [doc, near, width, number]);

  return (
    <div
      ref={holder}
      className="gb-pdf-page"
      data-drawn={drawn ? 'true' : undefined}
      style={{ width, height }}
      aria-label={`Page ${number}`}
      role="img"
    >
      <canvas ref={canvas} />
    </div>
  );
}
