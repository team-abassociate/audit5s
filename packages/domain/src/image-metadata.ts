import type { AllowedImageType } from './evidence';

/**
 * Metadata stripping and dimension reading, as pure byte transformations
 * (ARCHITECTURE.md §12.8, STACK.md §5 "Media").
 *
 * > **Metadata leakage** — EXIF stripped except orientation; GPS is captured explicitly
 * > into columns, not left silently in the file.
 *
 * The device already does this at capture (`src/lib/capture/media.ts` re-encodes, which
 * drops every metadata segment). This is the server's second pass over the same rule —
 * defence in depth, not suspicion: nothing else in the system treats a device as hostile,
 * and a photograph that arrives clean is left byte-identical by everything below.
 *
 * **Structural, never a re-encode.** A decode-and-re-encode would strip metadata too, and
 * would be three lines instead of this file — but it would also recompress a photograph
 * the reports print at full size (§4.1 asks for print quality, not thumbnails), lose the
 * orientation §12.8 explicitly preserves, and put a decoder in front of every object.
 * Removing whole segments and chunks from the container touches no pixel: the image that
 * comes out is the image that went in, minus the metadata.
 *
 * **Pure, and here rather than in the worker**, for the same reason `sniffImageType` is:
 * it is a function of bytes with no IO, so it can be tested against real files and hand-
 * built adversarial ones without a queue, a bucket or a database.
 */

/** What a strip did. `removed` empty means the bytes came back unchanged. */
export interface StrippedImage {
  bytes: Uint8Array;
  /**
   * The segments or chunks that were dropped, named as they appear in the file — `APP1`,
   * `COM`, `eXIf`, `XMP `. Reported rather than counted so the worker's log says *what*
   * a device sent that it should not have, which is the diagnostic worth having.
   */
  removed: string[];
  /** EXIF orientation (1–8) found and preserved, or null when there was none. */
  orientation: number | null;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Removes every metadata segment, keeping EXIF orientation.
 *
 * Returns `null` when the container cannot be parsed — a truncated or malformed file.
 * That is not the same as "nothing to remove": the caller must treat null as "this object
 * could not be sanitised" and say so, rather than storing it as verified clean.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  contentType: AllowedImageType,
): StrippedImage | null {
  switch (contentType) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
  }
}

/**
 * Width and height from the header alone.
 *
 * §12.8's zip-bomb control is "images decoded only in the sandboxed media worker with
 * resource limits", and this is what makes the limit checkable *before* the decode: a
 * 40 kB file that declares 30000 × 30000 is refused on its header rather than after it has
 * allocated 3.6 GB of bitmap. Returns null when the header cannot be read, which the
 * caller must treat as "do not decode".
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return jpegDimensions(bytes) ?? pngDimensions(bytes) ?? webpDimensions(bytes);
}

// ------------------------------------------------------------------------------- JPEG

/** Markers that stand alone: no length, no payload. */
const JPEG_STANDALONE = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function isApp(marker: number): boolean {
  return marker >= 0xe0 && marker <= 0xef;
}

/**
 * Rewrites a JPEG's marker stream without its `APPn` and `COM` segments.
 *
 * Everything from `SOS` (`FFDA`) onward is copied verbatim: that is the entropy-coded
 * scan, it contains no metadata, and re-scanning it for marker-like byte pairs would
 * corrupt the image — `FFD0`–`FFD7` restart markers and stuffed `FF00` bytes live there
 * legitimately.
 */
function stripJpeg(bytes: Uint8Array): StrippedImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const removed: string[] = [];
  let orientation: number | null = null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Padding between segments is legal (any number of 0xFF fill bytes); anything else
      // here means the stream is not where we think it is, and guessing would corrupt it.
      return null;
    }

    let markerAt = offset;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) return null;

    if (JPEG_STANDALONE.has(marker)) {
      kept.push(bytes.subarray(offset, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 1 >= bytes.length) return null;
    const length = (bytes[lengthAt]! << 8) | bytes[lengthAt + 1]!;
    if (length < 2) return null;
    const end = lengthAt + length;
    if (end > bytes.length) return null;

    if (marker === 0xda) {
      // SOS: copy the header and then the rest of the file untouched.
      kept.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }

    if (isApp(marker) || marker === 0xfe) {
      const payload = bytes.subarray(lengthAt + 2, end);

      if (marker === 0xe0 && isBareJfif(payload)) {
        // A bare `APP0` is the JFIF header — version, pixel density, and two zero bytes
        // where an embedded thumbnail would go. It is structure, not metadata: it carries
        // nothing about who took the photograph or where, and every JPEG encoder emits one
        // (the device's `processCapturedPhoto` included).
        //
        // Dropping it would be the difference between sanitising the rare photograph that
        // arrives dirty and rewriting *every* photograph in the system — which would cost
        // a storage round trip per upload and, worse, make `stored_checksum_sha256`
        // non-null always, destroying the one thing it is there to tell you (R-12c).
        //
        // A `JFXX` extension or a `JFIF` carrying a thumbnail is not bare and is removed
        // like any other segment: those *can* hold an image.
        kept.push(bytes.subarray(offset, end));
        offset = end;
        continue;
      }

      if (marker === 0xe1) {
        orientation = exifOrientation(payload) ?? orientation;
      }
      removed.push(marker === 0xfe ? 'COM' : `APP${marker - 0xe0}`);
      offset = end;
      continue;
    }

    kept.push(bytes.subarray(offset, end));
    offset = end;
  }

  if (removed.length === 0) {
    return { bytes, removed, orientation };
  }

  // §12.8 keeps orientation. A value of 1 is "as stored", so re-emitting it would add a
  // segment that says nothing — the absence of an orientation tag already means 1.
  if (orientation !== null && orientation !== 1) {
    kept.splice(1, 0, orientationOnlyApp1(orientation));
  }

  return { bytes: concat(kept), removed, orientation };
}

/** A minimal `APP1` carrying nothing but `Orientation`, big-endian TIFF. */
function orientationOnlyApp1(orientation: number): Uint8Array {
  const payload = new Uint8Array(32);
  const view = new DataView(payload.buffer);

  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
  payload.set([0x4d, 0x4d, 0x00, 0x2a], 6); // "MM", 42 — big-endian TIFF
  view.setUint32(10, 8); // IFD0 begins immediately after the 8-byte header
  view.setUint16(14, 1); // one entry
  view.setUint16(16, 0x0112); // Orientation
  view.setUint16(18, 3); // SHORT
  view.setUint32(20, 1); // one value
  view.setUint16(24, orientation); // the value, left-aligned in the 4-byte field
  view.setUint32(28, 0); // no next IFD

  const segment = new Uint8Array(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = (payload.length + 2) >> 8;
  segment[3] = (payload.length + 2) & 0xff;
  segment.set(payload, 4);
  return segment;
}

/**
 * A JFIF `APP0` with no embedded thumbnail: `"JFIF\0"`, version, density, and `0 × 0`.
 *
 * Exactly fourteen bytes. Anything longer is carrying something, and anything else in the
 * `APP0` slot — `JFXX`, which exists precisely to hold a thumbnail — is not this.
 */
function isBareJfif(payload: Uint8Array): boolean {
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00];
  return (
    payload.length === 14 &&
    jfif.every((byte, index) => payload[index] === byte) &&
    payload[12] === 0 &&
    payload[13] === 0
  );
}

/** `Orientation` out of an `APP1` payload, or null when it is not an EXIF APP1. */
function exifOrientation(payload: Uint8Array): number | null {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  if (payload.length < 14 || header.some((byte, index) => payload[index] !== byte)) {
    return null;
  }

  const tiff = payload.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const littleEndian = tiff[0] === 0x49 && tiff[1] === 0x49;
  const bigEndian = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;
  if (view.getUint16(2, littleEndian) !== 42) return null;

  const ifd0 = view.getUint32(4, littleEndian);
  if (ifd0 + 2 > tiff.byteLength) return null;

  const count = view.getUint16(ifd0, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd0 + 2 + index * 12;
    if (entry + 12 > tiff.byteLength) return null;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;

    const value = view.getUint16(entry + 8, littleEndian);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let markerAt = offset;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) return null;

    if (JPEG_STANDALONE.has(marker)) {
      offset = markerAt + 1;
      continue;
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 1 >= bytes.length) return null;
    const length = (bytes[lengthAt]! << 8) | bytes[lengthAt + 1]!;

    // SOFn — every frame type except DHT (C4), JPG (C8) and DAC (CC) — carries the size.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (lengthAt + 7 >= bytes.length) return null;
      return {
        height: (bytes[lengthAt + 3]! << 8) | bytes[lengthAt + 4]!,
        width: (bytes[lengthAt + 5]! << 8) | bytes[lengthAt + 6]!,
      };
    }

    if (marker === 0xda) return null; // the scan began and no frame header was found
    offset = lengthAt + length;
  }
  return null;
}

// -------------------------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Metadata chunks. All ancillary — a decoder that does not understand them ignores them —
 * so dropping them whole leaves a valid PNG and every per-chunk CRC intact, because a CRC
 * covers only its own chunk.
 */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

function stripPng(bytes: Uint8Array): StrippedImage | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return null;
  }

  const removed: string[] = [];
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;

    if (PNG_METADATA_CHUNKS.has(type)) {
      removed.push(type);
    } else {
      kept.push(bytes.subarray(offset, end));
    }

    offset = end;
    if (type === 'IEND') break;
  }

  return removed.length === 0
    ? { bytes, removed, orientation: null }
    : { bytes: concat(kept), removed, orientation: null };
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  if (asciiAt(bytes, 12, 4) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ------------------------------------------------------------------------------- WebP

/** The RIFF chunks that carry metadata, and the `VP8X` flag bits that advertise them. */
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(bytes: Uint8Array): StrippedImage | null {
  if (bytes.length < 12 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') {
    return null;
  }

  const removed: string[] = [];
  const body: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    // RIFF pads every chunk to an even length; the pad byte is not counted in `size`.
    const end = offset + 8 + size + (size % 2);
    if (offset + 8 + size > bytes.length) return null;

    if (WEBP_METADATA_CHUNKS.has(fourcc)) {
      removed.push(fourcc);
    } else if (fourcc === 'VP8X') {
      // The extended header advertises which optional chunks follow. Leaving the bits set
      // after removing the chunks would describe a file that no longer exists.
      const chunk = Uint8Array.from(bytes.subarray(offset, Math.min(end, bytes.length)));
      if (chunk.length > 8) {
        chunk[8] = chunk[8]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      }
      body.push(chunk);
    } else {
      body.push(bytes.subarray(offset, Math.min(end, bytes.length)));
    }

    offset = end;
  }

  if (removed.length === 0) {
    return { bytes, removed, orientation: null };
  }

  const payload = concat(body);
  const out = new Uint8Array(12 + payload.length);
  out.set(bytes.subarray(0, 12), 0);
  out.set(payload, 12);
  // The RIFF size counts everything after its own four bytes: "WEBP" plus the chunks.
  new DataView(out.buffer).setUint32(4, 4 + payload.length, true);

  return { bytes: out, removed, orientation: null };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') {
    return null;
  }
  // Only the extended header states the canvas size outright. `VP8 ` and `VP8L` encode it
  // inside the bitstream, and reading that would be a decoder — which is what this exists
  // to avoid. Null means "the caller must fall back to the byte cap".
  if (asciiAt(bytes, 12, 4) !== 'VP8X') return null;

  const at = (index: number): number =>
    bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16);
  return { width: at(24) + 1, height: at(27) + 1 };
}

// ---------------------------------------------------------------------------- helpers

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
