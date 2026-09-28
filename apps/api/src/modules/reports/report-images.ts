import sharp from "sharp";
import { readImageDimensions } from "@audit5s/domain";

/**
 * Photographs sized for the page they print on, so every report stays under a hard cap.
 *
 * A photo arrives at up to 1920 px (§9.4) and prints 52–62 mm wide. At 300 dpi that is
 * about 730 px; 1200 px is comfortably above it, so the first tier loses nothing a printer
 * can show. Embedding the originals made a Zone report roughly the sum of its JPEGs —
 * several megabytes for a busy Zone — with no ceiling at all.
 *
 * The cap is hard (product decision): a report is never over `REPORT_MAX_BYTES`. A Zone with
 * a handful of findings keeps tier 0; one with fifty steps down until it fits, and the
 * last tiers exist so that it always does.
 *
 * The codec is `sharp` (libvips), not the pure-JavaScript `jimp` it replaced: decoding one
 * 1920 px photograph in `jimp` took about three seconds, and a summary re-encodes every
 * photograph at two or three tiers while it searches for the one that fits — minutes per
 * report on a concurrency-1 worker. libvips does the same work in tens of milliseconds, and
 * shrinks a JPEG *while* decoding it. The pinned version gives the same bytes for the same
 * input on the same platform, which is all PART 15.7's frozen content needs (DECISIONS.md
 * R-36).
 */

// A long-running worker renders unrelated reports one after another; libvips' operation
// cache would only hold memory the 1536 MB container is short of.
sharp.cache(false);

/** 1 MB, counted in bytes as a phone's share sheet counts them. */
export const REPORT_MAX_BYTES = 1_000_000;

export interface ImageTier {
  /** Long edge for a finding or good-practice photo. */
  photoPx: number;
  /** Long edge for the auditor's selfie, which prints in a smaller box. */
  selfiePx: number;
  quality: number;
}

export const REPORT_IMAGE_TIERS: readonly ImageTier[] = [
  { photoPx: 1200, selfiePx: 800, quality: 80 },
  { photoPx: 1000, selfiePx: 700, quality: 75 },
  { photoPx: 900, selfiePx: 600, quality: 70 },
  { photoPx: 800, selfiePx: 520, quality: 65 },
  { photoPx: 650, selfiePx: 440, quality: 60 },
  { photoPx: 520, selfiePx: 360, quality: 55 },
  { photoPx: 420, selfiePx: 300, quality: 50 },
  { photoPx: 320, selfiePx: 240, quality: 45 },
  // A Zone with dozens of findings. Still legible as a record of what was found; this is
  // the price of a hard cap, and only a very large report ever pays it.
  { photoPx: 260, selfiePx: 200, quality: 40 },
  { photoPx: 200, selfiePx: 160, quality: 35 },
];

/** The same bound the media worker keeps (§12.8): a header is read before any decode. */
const MAX_DECODABLE_PIXELS = 24_000_000;

export type ImageSlot = "photo" | "selfie";

export interface SourceImage {
  slot: ImageSlot;
  bytes: Buffer;
  contentType: string;
}

export interface FittedImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * A photograph checked once and ready to be encoded at any tier.
 *
 * `decodable` is false when the header is unreadable or declares more pixels than the
 * decode cap; such a file is then embedded as it came rather than dropped. There is no
 * bitmap held here: libvips re-reads the compressed bytes at each tier, shrinking on load,
 * which is both faster and far lighter on memory than keeping fifty decoded bitmaps.
 */
export interface PreparedImage {
  source: SourceImage;
  decodable: boolean;
}

export async function prepareImage(
  source: SourceImage,
): Promise<PreparedImage> {
  const dimensions = readImageDimensions(source.bytes);
  return {
    source,
    decodable:
      dimensions !== null &&
      dimensions.width * dimensions.height <= MAX_DECODABLE_PIXELS,
  };
}

/**
 * One photograph at one tier. Never upscales, honours the EXIF orientation the media worker
 * kept (§12.8) by baking it into the pixels, and a file that cannot be decoded is embedded as
 * it came rather than dropped — a larger report beats a missing finding.
 */
export async function fitImage(
  prepared: PreparedImage,
  tier: ImageTier,
): Promise<FittedImage> {
  const { source, decodable } = prepared;
  if (!decodable) {
    return { bytes: source.bytes, contentType: source.contentType };
  }
  try {
    const edge = source.slot === "selfie" ? tier.selfiePx : tier.photoPx;
    const bytes = await sharp(source.bytes, {
      limitInputPixels: MAX_DECODABLE_PIXELS,
    })
      .rotate()
      .resize({
        width: edge,
        height: edge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: tier.quality })
      .toBuffer();
    return { bytes, contentType: "image/jpeg" };
  } catch {
    return { bytes: source.bytes, contentType: source.contentType };
  }
}

export function toDataUri(image: FittedImage): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}
