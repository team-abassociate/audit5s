import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright-core';
import type { ReportPayload } from '@audit5s/contracts';
import { CONFIG, type AppConfig } from '../../config/env';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { REPORT_FONT_STACK, REPORT_MONO_STACK, renderReportHtml } from './templates';

export interface RenderedReport {
  pdf: Buffer;
  checksumSha256: string;
  pageCount: number | null;
}

/**
 * HTML → PDF, in `worker-report` and nowhere else (STACK.md §5).
 *
 * **Determinism is the requirement**, not a nicety: PART 15.7 asserts that a fixed payload
 * produces a byte-stable PDF, and that assertion is what makes "regeneration leaves v1
 * byte-identical" checkable rather than hoped for. Four things secure it, and each of them
 * is a way the property is usually lost:
 *
 *   1. **No network at render time.** Photographs are fetched from object storage *before*
 *      Chromium starts and embedded as `data:` URIs, and the stylesheet uses system fonts
 *      only. A presigned GET resolved inside the page would make the document depend on
 *      request timing, and a webfont on whether a CDN answered (DECISIONS.md R-14).
 *   2. **No clock.** `generatedAt` is frozen in the payload; the template never calls
 *      `new Date()`, and Chromium's own header/footer — which would print today's date —
 *      is switched off in favour of the CSS footer. The last clock is Skia's own, in the
 *      PDF metadata, and `freezePdfDates` below replaces it with the same frozen instant.
 *   3. **No animation.** `prefers-reduced-motion` is forced, so nothing is captured
 *      mid-transition.
 *   4. **One browser, pinned.** Concurrency 1, the version pinned by the lockfile.
 *   5. **No cold first render.** The four above left one clock running that nobody had
 *      named: the browser's own start-up. A freshly launched Chromium resolved this
 *      template's font stack — which is `Helvetica`/`Arial` on a host that has neither, so
 *      every glyph goes through fontconfig substitution — to different bytes than the same
 *      browser resolved a moment later, and PART 15.7 caught it as an intermittent failure
 *      roughly one run in four. In production it is worse than intermittent: the browser is
 *      reused across jobs, so it was *always* the first report after a worker restart that
 *      differed, which is exactly the regeneration R-14 promises will be byte-identical.
 *      `warmUp` below spends one throwaway render on it so no report is ever the first.
 *
 * The browser is launched per job rather than held open. That costs about a second and
 * buys the thing a 1536 MB container actually needs: a renderer that leaks nothing between
 * jobs, and a crash that kills one report rather than the worker.
 */
@Injectable()
export class ReportRenderer implements OnModuleDestroy {
  private readonly logger = new Logger(ReportRenderer.name);
  private browser: Browser | null = null;

  constructor(
    private readonly storage: ObjectStorage,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /** The whole pipeline: fetch images, build HTML, print, freeze the dates, checksum. */
  async render(payload: ReportPayload): Promise<RenderedReport> {
    const images = await this.fetchImages(payload);
    const html = renderReportHtml(payload, (key) => images.get(key) ?? null);
    const pdf = freezePdfDates(await this.printToPdf(html), payload.generatedAt);

    return {
      pdf,
      checksumSha256: createHash('sha256').update(pdf).digest('hex'),
      pageCount: countPages(pdf),
    };
  }

  /** HTML only — `POST /reports/preview` (§8.9), for template iteration. No PDF, no row. */
  async renderHtml(payload: ReportPayload): Promise<string> {
    const images = await this.fetchImages(payload);
    return renderReportHtml(payload, (key) => images.get(key) ?? null);
  }

  /**
   * Every object key the payload names, fetched once and embedded.
   *
   * Deduplicated by key: the same photograph can appear as a Zone's nonconformity and
   * again in the summary's flagged block, and downloading a 4 MB image twice per report is
   * the kind of waste that only shows up as a slow queue.
   *
   * A missing object does not fail the report. A render that refuses because one
   * photograph has gone would lose the other forty-nine findings; the template prints
   * "Photo unavailable" in its place, which is both honest and recoverable by regenerating.
   */
  private async fetchImages(payload: ReportPayload): Promise<Map<string, string>> {
    const keys = new Set<string>();
    const add = (key: string | null | undefined) => {
      if (key) keys.add(key);
    };

    add(payload.audit?.selfieObjectKey);
    for (const zone of payload.zones) {
      for (const photo of zone.good) add(photo.objectKey);
      for (const item of zone.nonconformities) {
        add(item.objectKey);
        add(item.outcome?.afterPhoto?.objectKey);
      }
    }

    const images = new Map<string, string>();
    for (const key of [...keys].sort()) {
      try {
        const bytes = await this.storage.get(key);
        images.set(key, `data:${contentTypeOf(key)};base64,${bytes.toString('base64')}`);
      } catch (error) {
        this.logger.warn({ err: error, key }, 'Report image could not be fetched; rendering without it');
      }
    }
    return images;
  }

  private async printToPdf(html: string): Promise<Buffer> {
    return this.printToPdfOn(await this.launch(), html);
  }

  /** The print itself, against an explicit browser: `warmUp` runs before `this.browser`
   *  is set, so it cannot go through `launch()` without recursing. */
  private async printToPdfOn(browser: Browser, html: string): Promise<Buffer> {
    const context = await browser.newContext({
      // Fixed viewport and scale factor: the print box comes from `@page`, but a
      // different device scale changes how sub-pixel positions round.
      viewport: { width: 1240, height: 1754 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
      locale: 'en-GB',
      timezoneId: 'UTC',
      javaScriptEnabled: false,
    });

    try {
      const page = await context.newPage();
      // `setContent` with no network idle wait: there is nothing to load. Every image is a
      // data URI and every font is a system font, which is the property this relies on.
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: this.config.REPORT_RENDER_TIMEOUT_MS,
      });

      return await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        // Chromium's own header/footer prints the URL and today's date. Both would make
        // two renders of one payload differ, and the footer §3.5 asks for is in the CSS.
        displayHeaderFooter: false,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
    } finally {
      await context.close();
    }
  }

  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Imported lazily so `apps/api` and `worker-general` never load a browser driver they
    // do not use — and so a missing Chromium is an error in the worker that needs it
    // rather than a boot failure of the API.
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      // STACK.md §2 pins `chrome-headless-shell`, not full Chromium: it is the build
      // without the browser UI, ~50 MB smaller, and the only thing this worker needs is a
      // renderer. An explicit executable path wins, for an image that ships its own.
      ...(this.config.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: this.config.CHROMIUM_EXECUTABLE_PATH }
        : { channel: 'chromium-headless-shell' }),
      args: [
        // STACK.md §5, both of them. /dev/shm in a container is 64 MB by default, and
        // Chromium rendering a photo-heavy A4 page will exhaust it and crash.
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        // Determinism: no lazy-loading heuristics, no background timers doing work while
        // the PDF is being produced.
        '--disable-lcd-text',
        '--force-device-scale-factor=1',
        '--font-render-hinting=none',
      ],
    });

    await this.warmUp(browser);
    this.browser = browser;
    return browser;
  }

  /**
   * One throwaway render, so the first *report* is never the first render.
   *
   * It goes through `printToPdf`'s own path rather than a shortcut — same context options,
   * same `setContent`, same `page.pdf()` — because the difference being absorbed is
   * whatever that path initialises lazily, and a cheaper imitation would warm something
   * else. It prints both type stacks over the full Latin alphabet and the ten digits so
   * the substitution fontconfig will use for the real report is the one resolved here.
   *
   * Failure is swallowed deliberately. A warm-up that cannot run leaves the renderer
   * exactly where it was before this existed — byte-stable only after its first job — and
   * refusing to launch over it would turn a determinism safeguard into an outage.
   */
  private async warmUp(browser: Browser): Promise<void> {
    const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 %.,()/-';
    try {
      await this.printToPdfOn(
        browser,
        `<!doctype html><html><head><meta charset="utf-8"><style>
           body { font-family: ${REPORT_FONT_STACK}; font-variant-numeric: tabular-nums; }
           code { font-family: ${REPORT_MONO_STACK}; }
         </style></head><body>${glyphs}<code>${glyphs}</code></body></html>`,
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Renderer warm-up failed; first render may not be byte-stable');
    }
  }
}

/**
 * Page count, read from the PDF's own `/Type /Page` objects.
 *
 * Approximate by construction — an object stream would hide them — so it returns `null`
 * rather than a wrong number when it finds none. The column is metadata for a UI, not
 * something anything branches on.
 */
function countPages(pdf: Buffer): number | null {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

/**
 * Skia stamps the wall clock into `/CreationDate` and `/ModDate`, to the second.
 *
 * That is the one source of nondeterminism the render pipeline could not switch off, and
 * it is invisible almost all of the time: two renders inside the same second agree, so
 * PART 15.7's byte-stability test passed roughly three runs in four and failed the fourth
 * with no other explanation. It is a real defect and not a flaky test — "the same payload
 * renders to the same bytes" (R-14) was simply not true across a second boundary.
 *
 * The replacement is written in place and is exactly as long as what it replaces, so every
 * byte offset in the cross-reference table stays valid: rewriting the dates to a different
 * width would corrupt the document. `generatedAt` is the payload's own frozen instant, so
 * the metadata now says what the printed footer says.
 */
export function freezePdfDates(pdf: Buffer, generatedAt: string): Buffer {
  const frozen = pdfDate(generatedAt);
  const text = pdf.toString('latin1');
  // `D:YYYYMMDDHHMMSS+HH'mm'` — the fixed-width form Skia writes.
  const rewritten = text.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/g,
    (_match, field: string) => `/${field} (${frozen})`,
  );
  const normalized = rewritten.replace(
    /\/ID\s*\[<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\]/g,
    '/ID [<00000000000000000000000000000000><00000000000000000000000000000000>]',
  );
  return Buffer.from(normalized, 'latin1');
}

/** An ISO instant as a PDF date string, always UTC and always the same 23 characters. */
function pdfDate(iso: string): string {
  const digits = new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `D:${digits}+00'00'`;
}

function contentTypeOf(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
