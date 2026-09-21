import { Jimp } from "jimp";
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
 * Jimp is pure JavaScript, so the same bytes in give the same bytes out on every machine —
 * which keeps PART 15.7's byte-stable render intact.
 */

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

type Bitmap = Awaited<ReturnType<typeof Jimp.read>>;

/**
 * A photograph decoded once and shrunk to the largest tier's size, ready to be encoded at
 * any tier. Decoding a 1920 px JPEG is the expensive step in pure JavaScript; doing it once
 * per photo rather than once per tier tried is what keeps a fifty-photo Zone inside the
 * worker's render timeout.
 */
export interface PreparedImage {
  source: SourceImage;
  /** Null when the file could not be decoded safely; it is then embedded as it came. */
  bitmap: Bitmap | null;
}

export async function prepareImage(
  source: SourceImage,
): Promise<PreparedImage> {
  const dimensions = readImageDimensions(source.bytes);
  if (
    !dimensions ||
    dimensions.width * dimensions.height > MAX_DECODABLE_PIXELS
  ) {
    return { source, bitmap: null };
  }
  try {
    const top = REPORT_IMAGE_TIERS[0]!;
    const edge = source.slot === "selfie" ? top.selfiePx : top.photoPx;
    const bitmap = await Jimp.read(source.bytes);
    if (Math.max(bitmap.width, bitmap.height) > edge) {
      bitmap.scaleToFit({ w: edge, h: edge });
    }
    return { source, bitmap };
  } catch {
    return { source, bitmap: null };
  }
}

/**
 * One photograph at one tier. Never upscales, and a file that cannot be decoded safely is
 * embedded as it came rather than dropped — a larger report beats a missing finding.
 */
export async function fitImage(
  prepared: PreparedImage,
  tier: ImageTier,
): Promise<FittedImage> {
  const { source, bitmap } = prepared;
  if (!bitmap) {
    return { bytes: source.bytes, contentType: source.contentType };
  }
  try {
    const edge = source.slot === "selfie" ? tier.selfiePx : tier.photoPx;
    let image = bitmap;
    if (Math.max(bitmap.width, bitmap.height) > edge) {
      // A copy: the prepared bitmap is the source for every other tier still to be tried.
      image = bitmap.clone();
      image.scaleToFit({ w: edge, h: edge });
    }
    const bytes = await image.getBuffer("image/jpeg", {
      quality: tier.quality,
    });
    return { bytes: Buffer.from(bytes), contentType: "image/jpeg" };
  } catch {
    return { bytes: source.bytes, contentType: source.contentType };
  }
}

export function toDataUri(image: FittedImage): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}
