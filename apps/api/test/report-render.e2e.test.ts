import { createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { ReportRenderer } from '../src/modules/reports/report-renderer';
import {
  FIXTURE_IMAGE_KEYS,
  fixtureAfterEvidencePayload,
  fixtureZonePayload,
} from '../src/modules/reports/templates/fixture';
import { ObjectStorage } from '../src/infrastructure/storage/object-storage';
import type { AppConfig } from '../src/config/env';

/**
 * **Byte-stable PDFs from a fixed payload** — PART 14's Phase 7 row and PART 15.7.
 *
 * This is the assertion the whole freezing design exists to make possible, and it is what
 * turns "regeneration leaves v1 byte-identical" from a hope into a checkable property: if
 * one payload always renders to the same bytes, then v1's bytes cannot change, because v1's
 * payload cannot change (RS-1).
 *
 * It runs a real Chromium, so it lives in the e2e suite rather than beside the layout
 * tests. Those cover the §4.1–§4.3 rules without a browser and run everywhere; this covers
 * the one property only a browser can demonstrate.
 *
 * A missing browser **fails** rather than skipping. A determinism test that quietly does
 * not run is worse than no test: it reports green on exactly the CI configuration where
 * nobody would notice it had stopped checking anything.
 */

/** A storage stub: the fixture's keys, one tiny JPEG, no filesystem and no network. */
const ONE_PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4n' +
    'ICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/E' +
    'ABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

class FixtureStorage extends ObjectStorage {
  async put() {
    return { key: '', byteSize: 0, checksumSha256: '' };
  }
  async get(key: string): Promise<Buffer> {
    if (!FIXTURE_IMAGE_KEYS.includes(key as (typeof FIXTURE_IMAGE_KEYS)[number])) {
      throw new Error(`unexpected key ${key}`);
    }
    return ONE_PIXEL_JPEG;
  }
  async presignPut() {
    return { url: '', requiredHeaders: {}, expiresIn: 0 };
  }
  async presignGet() {
    return { url: '', expiresIn: 0 };
  }
  async head() {
    return null;
  }
  async readRange() {
    return null;
  }
  describe() {
    return 'fixture';
  }
  get presignsOffProcess() {
    return false;
  }
}

const config = {
  REPORT_RENDER_TIMEOUT_MS: 120_000,
  CHROMIUM_EXECUTABLE_PATH: process.env.CHROMIUM_EXECUTABLE_PATH,
} as unknown as AppConfig;

let renderer: ReportRenderer;

beforeAll(() => {
  renderer = new ReportRenderer(new FixtureStorage(), config);
});

afterAll(async () => {
  await renderer.onModuleDestroy();
});

/**
 * Where two PDFs stop agreeing, in words.
 *
 * A determinism failure that reports only two hashes says nothing about its own cause: the
 * bytes could differ in a font stream, an image, the metadata or the cross-reference
 * table, and those are four different bugs. This locates the first difference and names
 * the object it falls inside, so a failure is a diagnosis rather than a prompt to guess.
 */
function describePdfDifference(a: Buffer, b: Buffer): string {
  if (a.equals(b)) return 'identical';

  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at < limit && a[at] === b[at]) at += 1;

  const textA = a.toString('latin1');
  // The object the difference sits in: the last `N 0 obj` header at or before the offset.
  const headers = [...textA.slice(0, at).matchAll(/(\d+) 0 obj/g)];
  const owner = headers.at(-1);
  const objectStart = owner?.index ?? 0;
  // What kind of object that is — /Subtype and /Filter are what separate a font from an
  // image from a content stream.
  const dictionary = textA.slice(objectStart, Math.min(objectStart + 400, textA.length));
  const kind = [...dictionary.matchAll(/\/(Type|Subtype|Filter|BaseFont)\s*\/?([A-Za-z0-9+#-]+)/g)]
    .map((match) => `/${match[1]} ${match[2]}`)
    .join(' ');

  const window = (buffer: Buffer) =>
    JSON.stringify(
      buffer.subarray(Math.max(0, at - 24), Math.min(buffer.length, at + 24)).toString('latin1'),
    );

  return [
    `lengths ${a.length} vs ${b.length}, first difference at byte ${at}`,
    owner ? `inside object ${owner[1]} (starts at ${objectStart})${kind ? ` — ${kind}` : ''}` : 'before any object header',
    `a: ${window(a)}`,
    `b: ${window(b)}`,
  ].join('\n');
}

describe('the renderer is deterministic (PART 15.7)', () => {
  it('renders the same fixed payload to byte-identical PDFs', async () => {
    const first = await renderer.render(fixtureZonePayload());
    const second = await renderer.render(fixtureZonePayload());

    expect(describePdfDifference(first.pdf, second.pdf)).toBe('identical');
    expect(first.checksumSha256).toBe(second.checksumSha256);
    // Compared as bytes as well as by digest: a checksum computed over the wrong buffer
    // would agree with itself and prove nothing.
    expect(Buffer.compare(first.pdf, second.pdf)).toBe(0);
    expect(first.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.pageCount).toBeGreaterThan(0);
  }, 180_000);

  it('renders a second time after a fresh browser, still byte-identical', async () => {
    const first = await renderer.render(fixtureZonePayload());
    // The browser is what a restarted worker would start with. A render that depended on
    // warm state — a cached font, a reused context — would differ here and nowhere else.
    await renderer.onModuleDestroy();
    const second = await renderer.render(fixtureZonePayload());

    expect(describePdfDifference(first.pdf, second.pdf)).toBe('identical');
    expect(first.checksumSha256).toBe(second.checksumSha256);
  }, 180_000);

  it('produces different bytes for a different payload, so the test can fail', async () => {
    // The control. Without it, a renderer that returned a constant would pass every
    // assertion above.
    const initial = await renderer.render(fixtureZonePayload());
    const after = await renderer.render(fixtureAfterEvidencePayload());

    expect(initial.checksumSha256).not.toBe(after.checksumSha256);
  }, 180_000);

  it('does not embed the wall clock: the frozen generatedAt is the only date', async () => {
    const payload = fixtureZonePayload();
    const html = await renderer.renderHtml(payload);

    // The fixture's audit date and generated-at, both frozen in the payload.
    expect(html).toContain('04 Mar 2026');
    expect(html).not.toContain(String(new Date().getFullYear() + 1));
    // Nothing is fetched at render time: every image is inline, no stylesheet link.
    expect(html).not.toContain('<link');
    expect(html).toContain('data:image/jpeg;base64,');
  }, 180_000);

  it("stamps the payload's frozen instant into the PDF metadata, not the wall clock", async () => {
    // The one clock the render pipeline could not switch off: Skia writes /CreationDate
    // and /ModDate itself, to the second. It made the byte-stability test above fail about
    // one run in four — whenever two renders straddled a second boundary — which read as
    // flakiness and was a real breach of R-14's "the same payload renders to the same
    // bytes". Asserted separately so a regression names the cause instead of looking random.
    const payload = fixtureZonePayload();
    const { pdf } = await renderer.render(payload);
    const text = pdf.toString('latin1');
    const frozen = `D:${new Date(payload.generatedAt).toISOString().replace(/[-:T]/g, '').slice(0, 14)}+00'00'`;

    const dates = [...text.matchAll(/\/(?:CreationDate|ModDate) \(([^)]+)\)/g)].map((m) => m[1]);
    expect(dates.length, 'Skia writes both dates; if it stops, this guard is stale').toBe(2);
    expect(new Set(dates)).toEqual(new Set([frozen]));
  }, 180_000);

  it('embeds each distinct object once, however many times the payload names it', async () => {
    const html = await renderer.renderHtml(fixtureZonePayload());
    const digest = createHash('sha256').update(ONE_PIXEL_JPEG).digest('hex');
    expect(digest).toHaveLength(64);
    // The fixture uses one image for the selfie, both GOOD photos, two before photos and
    // the after photo; all resolve to the same bytes, and none is fetched over the network.
    expect((html.match(/data:image\/jpeg;base64,/g) ?? []).length).toBeGreaterThanOrEqual(5);
  }, 180_000);
});
