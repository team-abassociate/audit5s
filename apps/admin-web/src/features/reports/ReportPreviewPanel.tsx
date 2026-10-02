import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Maximize, Minimize, Minus, Plus } from 'lucide-react';
import type { ReportKind, ReportSnapshot } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge, Button, ErrorNotice } from '@/components/ui';
import { PdfViewer, type PdfViewerHandle, type PdfZoom } from './PdfViewer';
import { documentTitle, formatWhen, reportName } from './report-library';
import {
  REPORT_PDF_ROOT,
  fetchReportPdf,
  openPdfInTab,
  reportPdfKey,
  savePdf,
} from './report-pdf';

const ZOOM_KEY = 'gemba-report-zoom';

/** The fixed scales on offer, `1` = 100%. − and + step between them from wherever the view is. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

function storedZoom(): PdfZoom {
  try {
    const stored = localStorage.getItem(ZOOM_KEY);
    if (stored === 'page' || stored === 'width') return stored;
    const scale = Number(stored);
    return (ZOOM_STEPS as readonly number[]).includes(scale) ? scale : 'width';
  } catch {
    return 'width';
  }
}

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * The report preview: the PDF beside the version history, so checking a report before it
 * goes to a client is a click on its row rather than a download.
 *
 * It sits beside the history rather than over it, with no scrim — previewing is part of
 * working through the list, not a detour from it. Another row's click, or ↑ / ↓, swaps the
 * document in place, opened at its first page and at the same zoom, which is how a reviewer
 * works through a site visit's dozen Zone reports without touching the mouse.
 *
 * Expand (F) lays the report over the whole dashboard at 100% — its printed size, for
 * reading it properly or presenting it on a call — and Esc or F puts it back at the zoom
 * it had. It is the page's own view, not the browser's full screen.
 *
 * Below 1180px there is no room beside the table, so the panel covers the page instead.
 */
export function ReportPreviewPanel({
  snapshot,
  snapshots,
  kindLabel,
  mayGenerate,
  onSelect,
  onClose,
}: {
  snapshot: ReportSnapshot;
  snapshots: readonly ReportSnapshot[];
  kindLabel: Record<ReportKind, string>;
  mayGenerate: boolean;
  onSelect: (snapshotId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const viewer = useRef<PdfViewerHandle>(null);
  const [zoom, setZoomState] = useState<PdfZoom>(storedZoom);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  // What a fit mode works out to, so the control can say "84%" and − / + step from it.
  const [scale, setScale] = useState(1);
  const dockedZoom = useRef<PdfZoom>(zoom);
  const [renderError, setRenderError] = useState<unknown>(null);

  const ready = snapshot.status === 'READY';
  const pdf = useQuery({
    queryKey: reportPdfKey(snapshot.id),
    queryFn: () => fetchReportPdf(snapshot.id),
    enabled: ready,
    staleTime: Infinity,
    // Kept for a short while after moving on, so ↑ then ↓ does not fetch v3 twice.
    gcTime: 120_000,
    retry: false,
  });

  // Another report opens at its first page, not wherever the last one was left.
  useEffect(() => {
    setPage(1);
    setPageCount(null);
    setRenderError(null);
  }, [snapshot.id]);

  // A closed preview holds no PDF in memory.
  useEffect(
    () => () => queryClient.removeQueries({ queryKey: REPORT_PDF_ROOT }),
    [queryClient],
  );

  const regenerate = useMutation({
    mutationFn: () => api.post<ReportSnapshot>(`/reports/${snapshot.id}/regenerate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports'] }),
  });

  // The docked panel's zoom is remembered; the expanded view's is not — it always opens at
  // 100%, and closing it returns to what the panel had.
  const setZoom = useCallback(
    (next: PdfZoom) => {
      setZoomState(next);
      if (full) return;
      try {
        localStorage.setItem(ZOOM_KEY, String(next));
      } catch {
        // The choice simply is not remembered.
      }
    },
    [full],
  );
  const zoomBy = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction === 1
          ? (ZOOM_STEPS.find((step) => step > scale + 0.005) ?? ZOOM_STEPS.at(-1)!)
          : ([...ZOOM_STEPS].reverse().find((step) => step < scale - 0.005) ?? ZOOM_STEPS[0]);
      setZoom(next);
    },
    [scale, setZoom],
  );

  const enterFull = useCallback(() => {
    dockedZoom.current = zoom;
    setZoomState(1);
    setFull(true);
  }, [zoom]);
  const exitFull = useCallback(() => {
    setFull(false);
    setZoomState(dockedZoom.current);
  }, []);

  const total = pageCount ?? snapshot.pageCount ?? 1;
  const step = useCallback(
    (delta: number) => viewer.current?.goTo(Math.min(Math.max(1, page + delta), total)),
    [page, total],
  );
  const move = useCallback(
    (delta: number) => {
      const index = snapshots.findIndex((row) => row.id === snapshot.id);
      const next = snapshots[index + delta];
      if (next) onSelect(next.id);
    },
    [snapshots, snapshot.id, onSelect],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"], dialog')
      ) {
        return;
      }

      if (event.key === 'Escape') {
        if (full) exitFull();
        else onClose();
      } else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowDown') move(1);
      else if (event.key === 'ArrowUp') move(-1);
      else if (event.key === 'f' || event.key === 'F') {
        if (full) exitFull();
        else enterFull();
      } else if (event.key === '+' || event.key === '=') zoomBy(1);
      else if (event.key === '-' || event.key === '_') zoomBy(-1);
      else if (event.key === '0') setZoom(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, step, move, onClose, enterFull, exitFull, zoomBy, setZoom]);

  const index = snapshots.findIndex((row) => row.id === snapshot.id);

  return (
    <aside
      className={cn('gb-pdfpanel', full && 'gb-pdfpanel--full')}
      aria-label={`Preview of ${reportName(snapshot)}, version ${snapshot.version}`}
    >
      <header className="gb-pdfpanel-head">
        <div className="min-w-0">
          <h2 className="gb-h2">{documentTitle(snapshot)}</h2>
          <p>
            {snapshot.subject.unitName} · {kindLabel[snapshot.kind]} · v{snapshot.version} ·{' '}
            {formatWhen(snapshot.generatedAt)} · {snapshot.generatedByName}
            {snapshots.length > 1 ? ` · ${index + 1} of ${snapshots.length}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="gb-pdfpanel-close"
          onClick={full ? exitFull : onClose}
          aria-label={full ? 'Back to the panel' : 'Close preview'}
          title={full ? 'Back to the panel (Esc)' : 'Close preview (Esc)'}
        >
          ✕
        </button>
      </header>

      {ready ? (
        <div className="gb-pdfpanel-tools" role="toolbar" aria-label="Preview controls">
          <div className="gb-pdfpanel-pager">
            <Button
              variant="secondary"
              onClick={() => step(-1)}
              disabled={page <= 1}
              aria-label="Previous page"
              title="Previous page (←)"
            >
              ◀
            </Button>
            <span className="gb-pdfpanel-count" aria-live="polite">
              {page} / {total}
            </span>
            <Button
              variant="secondary"
              onClick={() => step(1)}
              disabled={page >= total}
              aria-label="Next page"
              title="Next page (→)"
            >
              ▶
            </Button>
          </div>
          <div className="gb-pdfpanel-zoom" role="group" aria-label="Zoom">
            <Button
              variant="secondary"
              className="gb-btn--icon gb-zoom-step"
              onClick={() => zoomBy(-1)}
              disabled={scale <= ZOOM_STEPS[0] + 0.005}
              aria-label="Zoom out"
              title="Zoom out (−)"
            >
              <Minus {...ICON} />
            </Button>
            <select
              className="gb-zoom-select"
              aria-label="Zoom"
              title={`Zoom — showing ${percent(scale)}. + and − step, 0 is 100%.`}
              value={typeof zoom === 'number' ? String(zoom) : zoom}
              onChange={(event) => {
                const value = event.target.value;
                setZoom(value === 'width' || value === 'page' ? value : Number(value));
                event.target.blur();
              }}
            >
              {/* A fit mode names itself and what it works out to; a fixed scale is just its
                  number, so the closed control always reads as the current size. */}
              <option value="width">{zoom === 'width' ? `${percent(scale)} fit` : 'Fit width'}</option>
              <option value="page">{zoom === 'page' ? `${percent(scale)} fit` : 'Fit page'}</option>
              {ZOOM_STEPS.map((step) => (
                <option key={step} value={String(step)}>
                  {percent(step)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              className="gb-btn--icon gb-zoom-step"
              onClick={() => zoomBy(1)}
              disabled={scale >= ZOOM_STEPS.at(-1)! - 0.005}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              <Plus {...ICON} />
            </Button>
          </div>
          {pdf.data?.checksum === 'verified' ? (
            <span
              className="gb-verified"
              title="Verified: the bytes match the checksum recorded when this report was issued."
            >
              <Badge tone="good">
                ✓<span className="gb-verified-word"> Verified</span>
              </Badge>
            </span>
          ) : null}
          {pdf.data?.checksum === 'mismatch' ? <Badge tone="bad">Checksum mismatch</Badge> : null}
          <span className="flex-1" />
          {full ? (
            <Button
              variant="secondary"
              className="gb-btn--icon"
              onClick={exitFull}
              aria-label="Back to the panel"
              title="Back to the panel (F or Esc)"
            >
              <Minimize {...ICON} />
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="gb-btn--icon"
              onClick={enterFull}
              aria-label="Expand, at 100%"
              title="Expand over the page, at 100% (F)"
            >
              <Maximize {...ICON} />
            </Button>
          )}
          <Button
            variant="secondary"
            className="gb-btn--icon"
            onClick={() => pdf.data && openPdfInTab(pdf.data)}
            disabled={!pdf.data}
            aria-label="Open in a new tab"
            title="Open in a new tab, in the browser's own viewer — to print"
          >
            <ExternalLink {...ICON} />
          </Button>
          <Button onClick={() => pdf.data && savePdf(pdf.data)} disabled={!pdf.data}>
            Download
          </Button>
        </div>
      ) : null}

      {pdf.data?.checksum === 'mismatch' ? (
        <p className="gb-pdfpanel-note gb-pdfpanel-note--crit">
          These bytes do not match the checksum recorded when v{snapshot.version} was issued.
          Do not send this copy; download it again, and report it if the mismatch stays.
        </p>
      ) : null}

      <div className="gb-pdfpanel-body">
        {ready && (pdf.error || renderError) ? (
          <div className="gb-pdfpanel-state">
            <ErrorNotice error={pdf.error ?? renderError} />
            <Button
              variant="secondary"
              onClick={() => {
                setRenderError(null);
                void pdf.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {snapshot.status === 'FAILED' ? (
          <div className="gb-pdfpanel-state">
            <Badge tone="bad">Failed</Badge>
            <p>{snapshot.failedReason ?? 'The renderer gave no reason.'}</p>
            {mayGenerate ? (
              <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
                {regenerate.isPending ? 'Queuing…' : 'Regenerate'}
              </Button>
            ) : null}
            {regenerate.error ? <ErrorNotice error={regenerate.error} /> : null}
          </div>
        ) : null}

        {snapshot.status === 'QUEUED' || snapshot.status === 'RENDERING' ? (
          <p className="gb-pdfpanel-note">
            {snapshot.status === 'QUEUED' ? 'Queued.' : 'Rendering.'} It opens here as soon as
            it is ready.
          </p>
        ) : null}

        {snapshot.status !== 'FAILED' && !(ready && (pdf.error || renderError)) ? (
          <PdfViewer
            key={snapshot.id}
            ref={viewer}
            bytes={pdf.data?.bytes ?? null}
            pageCountHint={snapshot.pageCount ?? 1}
            zoom={zoom}
            onPage={setPage}
            onScale={setScale}
            onPageCount={setPageCount}
            onError={setRenderError}
          />
        ) : null}
      </div>

      <p className="gb-pdfpanel-keys" aria-hidden>
        ← → page · ↑ ↓ report · + − zoom · F expand · Esc close
      </p>
    </aside>
  );
}

/**
 * The toolbar's icons, from Lucide — shadcn/ui's set (STACK.md §2) — drawn like `EyeIcon`
 * in `components/ui.tsx`: a 2px stroke in `currentColor`, so they follow the theme and a
 * disabled button's ink. Lucide rounds its line ends; these are squared, because nothing
 * on this board is rounded. Every button that carries one also carries an `aria-label` and
 * a title naming what it does, and the icon swaps without animating: fitting and paging
 * are pressed dozens of times in one review.
 */
const ICON = {
  size: 16,
  strokeWidth: 2,
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
  'aria-hidden': true,
  focusable: false,
} as const;
