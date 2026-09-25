import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";
import type { ReportPayload } from "@audit5s/contracts";
import { CONFIG, type AppConfig } from "../../config/env";
import { ObjectStorage } from "../../infrastructure/storage/object-storage";
import { renderReportHtml } from "./templates";
import {
  REPORT_IMAGE_TIERS,
  REPORT_MAX_BYTES,
  fitImage,
  prepareImage,
  toDataUri,
  type FittedImage,
  type PreparedImage,
  type SourceImage,
} from "./report-images";

export interface RenderedReport {
  pdf: Buffer;
  checksumSha256: string;
  pageCount: number | null;
  /** Which of `REPORT_IMAGE_TIERS` the photographs were printed at; 0 is the sharpest. */
  imageTier: number;
}

/** What a report weighs besides its photographs, until one print has measured it. */
const INITIAL_OVERHEAD_BYTES = 200_000;

/**
 * HTML → PDF, in `worker-report` and nowhere else (STACK.md §5).
 *
 * A fixed payload produces a stable document (PART 15.7, R-35). Chromium can give that
 * document different PDF bytes through image-object sharing, even inside one browser.
 * RS-1 instead keeps each issued PDF byte-identical by preserving its stored bytes.
 * Four things keep the document independent of render-time state:
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
 *   4. **Pinned browser.** Concurrency 1, the version pinned by the lockfile.
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

  /**
   * The whole pipeline: fetch images, size them, build HTML, print, freeze the dates,
   * checksum — under `REPORT_MAX_BYTES`, always.
   *
   * The sharpest tier whose photographs fit is found by binary search over estimates
   * (photo bytes + what the rest of the report weighs), so a fifty-finding Zone costs a few
   * re-encodes rather than one per tier; the estimate is then checked against a real print,
   * and a print that still comes out over the cap steps down and prints again.
   */
  async render(payload: ReportPayload): Promise<RenderedReport> {
    const sources = await this.prepareImages(await this.fetchImages(payload));
    const fitted = new Map<number, Map<string, FittedImage>>();
    const atTier = async (tier: number) => {
      let images = fitted.get(tier);
      if (!images) {
        images = new Map();
        for (const [key, source] of sources) {
          images.set(key, await fitImage(source, REPORT_IMAGE_TIERS[tier]!));
          // Jimp is synchronous CPU work. Yielding between photographs keeps the worker's
          // queue heartbeat alive through a fifty-photo report.
          await new Promise((resolve) => setImmediate(resolve));
        }
        fitted.set(tier, images);
      }
      return images;
    };
    const weight = (images: Map<string, FittedImage>) =>
      [...images.values()].reduce(
        (total, image) => total + image.bytes.byteLength,
        0,
      );

    const last = REPORT_IMAGE_TIERS.length - 1;
    let overhead = INITIAL_OVERHEAD_BYTES;
    let from = 0;

    for (;;) {
      const tier = await this.sharpestFitting(from, last, overhead, async (t) =>
        weight(await atTier(t)),
      );
      const images = await atTier(tier);
      const html = renderReportHtml(payload, (key) => {
        const image = images.get(key);
        return image ? toDataUri(image) : null;
      });
      const pdf = freezePdfDates(
        await this.printToPdf(html),
        payload.generatedAt,
      );

      if (pdf.byteLength <= REPORT_MAX_BYTES || tier === last) {
        if (pdf.byteLength > REPORT_MAX_BYTES) {
          this.logger.warn(
            `Report is ${pdf.byteLength} bytes at the smallest photo tier — over the ` +
              `${REPORT_MAX_BYTES}-byte cap on text alone`,
          );
        }
        return {
          pdf,
          checksumSha256: createHash("sha256").update(pdf).digest("hex"),
          pageCount: countPages(pdf),
          imageTier: tier,
        };
      }

      // The estimate was optimistic; the print has now measured the rest of the report.
      overhead = Math.max(overhead, pdf.byteLength - weight(images));
      from = tier + 1;
    }
  }

  /** HTML only — `POST /reports/preview` (§8.9), for template iteration. No PDF, no row. */
  async renderHtml(payload: ReportPayload): Promise<string> {
    const sources = await this.prepareImages(await this.fetchImages(payload));
    const images = new Map<string, string>();
    for (const [key, source] of sources) {
      images.set(
        key,
        toDataUri(await fitImage(source, REPORT_IMAGE_TIERS[0]!)),
      );
    }
    return renderReportHtml(payload, (key) => images.get(key) ?? null);
  }

  /** Every photograph decoded once, yielding between them for the same reason as above. */
  private async prepareImages(
    sources: Map<string, SourceImage>,
  ): Promise<Map<string, PreparedImage>> {
    const prepared = new Map<string, PreparedImage>();
    for (const [key, source] of sources) {
      prepared.set(key, await prepareImage(source));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return prepared;
  }

  /**
   * The lowest tier index in [from, last] whose estimated size fits. Photo bytes only fall
   * as the index rises, so this is a binary search; `from` itself is tried first because
   * it is the answer for every ordinary report.
   */
  private async sharpestFitting(
    from: number,
    last: number,
    overhead: number,
    photoBytes: (tier: number) => Promise<number>,
  ): Promise<number> {
    const fits = async (tier: number) =>
      (await photoBytes(tier)) + overhead <= REPORT_MAX_BYTES;
    if (from >= last || (await fits(from))) return from;

    let low = from + 1;
    let high = last;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (await fits(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
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
  private async fetchImages(
    payload: ReportPayload,
  ): Promise<Map<string, SourceImage>> {
    const keys = new Set<string>();
    const add = (key: string | null | undefined) => {
      if (key) keys.add(key);
    };

    const selfie = payload.audit?.selfieObjectKey ?? null;
    add(selfie);
    for (const zone of payload.zones) {
      for (const photo of zone.good) add(photo.objectKey);
      for (const item of zone.nonconformities) {
        add(item.objectKey);
        add(item.outcome?.afterPhoto?.objectKey);
      }
    }

    const images = new Map<string, SourceImage>();
    for (const key of [...keys].sort()) {
      try {
        const bytes = await this.storage.get(key);
        images.set(key, {
          slot: key === selfie ? "selfie" : "photo",
          bytes: Buffer.from(bytes),
          contentType: contentTypeOf(key),
        });
      } catch (error) {
        this.logger.warn(
          { err: error, key },
          "Report image could not be fetched; rendering without it",
        );
      }
    }
    return images;
  }

  private async printToPdf(html: string): Promise<Buffer> {
    const browser = await this.launch();
    const context = await browser.newContext({
      // Fixed viewport and scale factor: the print box comes from `@page`, but a
      // different device scale changes how sub-pixel positions round.
      viewport: { width: 1240, height: 1754 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
      locale: "en-GB",
      timezoneId: "UTC",
      javaScriptEnabled: false,
    });

    try {
      const page = await context.newPage();
      // `setContent` with no network idle wait: there is nothing to load. Every image is a
      // data URI and every font is a system font, which is the property this relies on.
      await page.setContent(html, {
        waitUntil: "load",
        timeout: this.config.REPORT_RENDER_TIMEOUT_MS,
      });

      return await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        // Chromium's own header/footer prints the URL and today's date. Both would make
        // two renders of one payload differ, and the footer §3.5 asks for is in the CSS.
        displayHeaderFooter: false,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
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
    const { chromium } = await import("playwright-core");
    this.browser = await chromium.launch({
      // STACK.md §2 pins `chrome-headless-shell`, not full Chromium: it is the build
      // without the browser UI, ~50 MB smaller, and the only thing this worker needs is a
      // renderer. An explicit executable path wins, for an image that ships its own.
      ...(this.config.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: this.config.CHROMIUM_EXECUTABLE_PATH }
        : { channel: "chromium-headless-shell" }),
      args: [
        // STACK.md §5, both of them. /dev/shm in a container is 64 MB by default, and
        // Chromium rendering a photo-heavy A4 page will exhaust it and crash.
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        // Determinism: no lazy-loading heuristics, no background timers doing work while
        // the PDF is being produced.
        "--disable-lcd-text",
        "--force-device-scale-factor=1",
        "--font-render-hinting=none",
      ],
    });
    return this.browser;
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
  const matches = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

/**
 * Skia stamps the wall clock into `/CreationDate` and `/ModDate`, to the second.
 *
 * This clock was invisible almost all of the time: two renders inside the same second
 * agreed, so PART 15.7's former byte-stability test failed roughly one run in four at second
 * boundaries. Freezing these dates removes the clock from each issued PDF's metadata;
 * R-35 separately records Chromium's image-object variation between fresh PDFs.
 *
 * The replacement is written in place and is exactly as long as what it replaces, so every
 * byte offset in the cross-reference table stays valid: rewriting the dates to a different
 * width would corrupt the document. `generatedAt` is the payload's own frozen instant, so
 * the metadata now says what the printed footer says.
 */
export function freezePdfDates(pdf: Buffer, generatedAt: string): Buffer {
  const frozen = pdfDate(generatedAt);
  const text = pdf.toString("latin1");
  // `D:YYYYMMDDHHMMSS+HH'mm'` — the fixed-width form Skia writes.
  const rewritten = text.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/g,
    (_match, field: string) => `/${field} (${frozen})`,
  );
  const normalized = rewritten.replace(
    /\/ID\s*\[<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\]/g,
    "/ID [<00000000000000000000000000000000><00000000000000000000000000000000>]",
  );
  return Buffer.from(normalized, "latin1");
}

/** An ISO instant as a PDF date string, always UTC and always the same 23 characters. */
function pdfDate(iso: string): string {
  const digits = new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `D:${digits}+00'00'`;
}

function contentTypeOf(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
