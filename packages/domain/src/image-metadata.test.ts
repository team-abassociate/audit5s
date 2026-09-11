import { describe, expect, it } from 'vitest';
import { readImageDimensions, stripImageMetadata } from './image-metadata';

/**
 * §12.8's metadata rule, against files built byte by byte.
 *
 * Built rather than checked in, because what is under test is the *container* handling —
 * which segment is dropped, which is kept, which byte of the RIFF size field is rewritten
 * — and a fixture photograph would exercise one arrangement of that while hiding the rest.
 * The adversarial cases (a header that declares 30000 px, a truncated file) cannot be
 * photographed at all.
 */

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

const ASCII = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** An EXIF `APP1` payload carrying `Orientation` plus a second tag, little-endian. */
function exifPayload(orientation: number): number[] {
  return [
    ...ASCII('Exif'),
    0x00,
    0x00,
    // "II" — little-endian, so the parser has to honour both byte orders
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    // GPSInfo (0x8825), LONG, 1, value 0 — the tag §12.8 is actually about
    0x25,
    0x88,
    0x04,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    // Orientation (0x0112), SHORT, 1
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    // no next IFD
    0x00,
    0x00,
    0x00,
    0x00,
  ];
}

const SOF0 = (width: number, height: number): number[] =>
  segment(0xc0, [
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);

/** The scan: an SOS header, entropy-coded bytes that *look* like markers, then EOI. */
const SCAN = [
  ...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
  0xaa,
  // a stuffed 0xFF inside the scan
  0xff,
  0x00,
  // a restart marker inside the scan
  0xff,
  0xd0,
  0xbb,
  // EOI
  0xff,
  0xd9,
];

/** `"JFIF\0"`, version 1.2, density units, 1 × 1 density, and 0 × 0 thumbnail. */
const BARE_JFIF = [...ASCII('JFIF'), 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

function jpeg(
  options: { orientation?: number; jfif?: boolean; jfxx?: boolean; comment?: string } = {},
): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...(options.jfif ? segment(0xe0, BARE_JFIF) : []),
    ...(options.jfxx ? segment(0xe0, [...ASCII('JFXX'), 0x00, 0x10, 0xff, 0xff]) : []),
    ...(options.orientation !== undefined ? segment(0xe1, exifPayload(options.orientation)) : []),
    ...(options.comment ? segment(0xfe, ASCII(options.comment)) : []),
    ...SOF0(1920, 1080),
    ...SCAN,
  ]);
}

describe('stripImageMetadata — JPEG', () => {
  it('drops every APPn and COM segment and names what it dropped', () => {
    const original = jpeg({ jfif: true, orientation: 6, comment: 'Shot on X' });
    const result = stripImageMetadata(original, 'image/jpeg')!;

    // `APP0` is absent from this list on purpose: a bare JFIF header is structure, not
    // metadata, and keeping it is what lets the ordinary photograph come back untouched.
    expect(result.removed).toEqual(['APP1', 'COM']);
    expect(result.orientation).toBe(6);
    expect(result.bytes.length).toBeLessThan(original.length);
  });

  it('keeps the orientation §12.8 exempts, and nothing else from the EXIF', () => {
    const result = stripImageMetadata(jpeg({ orientation: 8 }), 'image/jpeg')!;

    // The rebuilt APP1 is 34 bytes of declared length: one tag, no GPS.
    const app1At = indexOfPair(result.bytes, 0xff, 0xe1);
    expect(app1At).toBe(2);
    expect((result.bytes[app1At + 2]! << 8) | result.bytes[app1At + 3]!).toBe(34);

    // The GPS tag is gone by number, not merely by size.
    expect(indexOfPair(result.bytes, 0x25, 0x88)).toBe(-1);
    // Round-trips: the rebuilt segment is itself readable.
    expect(stripImageMetadata(result.bytes, 'image/jpeg')!.orientation).toBe(8);
  });

  it('emits no orientation segment when the orientation was already 1', () => {
    // Absence already means "as stored"; a segment saying so would be metadata added by
    // the sanitiser.
    const result = stripImageMetadata(jpeg({ orientation: 1, jfif: true }), 'image/jpeg')!;
    expect(result.removed).toEqual(['APP1']);
    expect(indexOfPair(result.bytes, 0xff, 0xe1)).toBe(-1);
  });

  it('leaves the scan and the frame header byte-identical', () => {
    const original = jpeg({ jfif: true, orientation: 3 });
    const result = stripImageMetadata(original, 'image/jpeg')!;

    // The scan carries byte pairs that look like markers on purpose. Re-scanning it would
    // corrupt the image; copying it verbatim is the whole reason SOS ends the walk.
    const scan = Uint8Array.from(SCAN);
    expect(endsWith(result.bytes, scan)).toBe(true);
    expect(endsWith(original, scan)).toBe(true);
    expect(readImageDimensions(result.bytes)).toEqual({ width: 1920, height: 1080 });
  });

  it('returns the same bytes, untouched, when there is nothing to remove', () => {
    // The normal case, and it has to include the JFIF header: every encoder emits one, so
    // a strip that removed it would rewrite *every* photograph in the system rather than
    // the rare dirty one — and would make `stored_checksum_sha256` non-null always,
    // destroying the one thing it reports (R-12c).
    const clean = jpeg({ jfif: true });
    const result = stripImageMetadata(clean, 'image/jpeg')!;
    expect(result.removed).toEqual([]);
    expect(result.bytes).toBe(clean);
  });

  it('removes a JFXX APP0, which can carry an embedded thumbnail', () => {
    // The exemption is for the *bare* JFIF header, not for the APP0 slot. `JFXX` exists
    // to hold a thumbnail, so it is metadata like any other segment.
    const result = stripImageMetadata(jpeg({ jfif: true, jfxx: true }), 'image/jpeg')!;
    expect(result.removed).toEqual(['APP0']);
    expect(indexOfAscii(result.bytes, 'JFXX')).toBe(-1);
    // …and the bare one beside it survives.
    expect(indexOfAscii(result.bytes, 'JFIF')).toBeGreaterThan(0);
  });

  it('refuses a file it cannot parse rather than guessing', () => {
    expect(stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(Uint8Array.from(ASCII('not a jpeg')), 'image/jpeg')).toBeNull();
    // A segment whose declared length runs past the end of the file.
    expect(
      stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x00]), 'image/jpeg'),
    ).toBeNull();
  });
});

describe('stripImageMetadata — PNG', () => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function chunk(type: string, data: number[]): number[] {
    const length = data.length;
    return [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
      ...ASCII(type),
      ...data,
      // CRC — a dropped chunk takes its own CRC with it, which is why whole-chunk removal
      // needs no recomputation.
      0x00,
      0x00,
      0x00,
      0x00,
    ];
  }

  const ihdr = chunk('IHDR', [0, 0, 0x07, 0x80, 0, 0, 0x04, 0x38, 8, 2, 0, 0, 0]);

  it('drops the text and EXIF chunks and keeps the image ones', () => {
    const png = Uint8Array.from([
      ...signature,
      ...ihdr,
      ...chunk('tEXt', ASCII('Comment taken at the plant')),
      ...chunk('eXIf', exifPayload(6).slice(6)),
      ...chunk('IDAT', [0x78, 0x9c, 0x00]),
      ...chunk('IEND', []),
    ]);

    const result = stripImageMetadata(png, 'image/png')!;
    expect(result.removed).toEqual(['tEXt', 'eXIf']);
    expect(result.orientation).toBeNull();
    expect(indexOfAscii(result.bytes, 'taken at the plant')).toBe(-1);
    expect(indexOfAscii(result.bytes, 'IDAT')).toBeGreaterThan(0);
    expect(indexOfAscii(result.bytes, 'IEND')).toBeGreaterThan(0);
    expect(readImageDimensions(result.bytes)).toEqual({ width: 1920, height: 1080 });
  });

  it('returns the same bytes when a PNG carries no metadata', () => {
    const png = Uint8Array.from([
      ...signature,
      ...ihdr,
      ...chunk('IDAT', [1]),
      ...chunk('IEND', []),
    ]);
    expect(stripImageMetadata(png, 'image/png')!.bytes).toBe(png);
  });

  it('refuses a PNG whose chunk length runs past the end', () => {
    const png = Uint8Array.from([...signature, 0x7f, 0xff, 0xff, 0xff, ...ASCII('IHDR')]);
    expect(stripImageMetadata(png, 'image/png')).toBeNull();
  });
});

describe('stripImageMetadata — WebP', () => {
  function riff(chunks: number[][]): Uint8Array {
    const body = chunks.flat();
    const size = 4 + body.length;
    return Uint8Array.from([
      ...ASCII('RIFF'),
      size & 0xff,
      (size >>> 8) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 24) & 0xff,
      ...ASCII('WEBP'),
      ...body,
    ]);
  }

  function chunk(fourcc: string, data: number[]): number[] {
    const size = data.length;
    return [
      ...ASCII(fourcc),
      size & 0xff,
      (size >>> 8) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 24) & 0xff,
      ...data,
      ...(size % 2 === 1 ? [0x00] : []),
    ];
  }

  // Flags with EXIF (0x08) and XMP (0x04) advertised, canvas 1920 × 1080.
  const vp8x = chunk('VP8X', [0x0c, 0, 0, 0, 0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]);

  it('drops the EXIF and XMP chunks and clears the flags that advertised them', () => {
    const webp = riff([
      vp8x,
      chunk('VP8 ', [0x01, 0x02, 0x03]),
      chunk('EXIF', exifPayload(6).slice(6)),
      chunk('XMP ', ASCII('<x:xmpmeta/>')),
    ]);

    const result = stripImageMetadata(webp, 'image/webp')!;
    expect(result.removed).toEqual(['EXIF', 'XMP ']);
    expect(indexOfAscii(result.bytes, 'EXIF')).toBe(-1);
    expect(indexOfAscii(result.bytes, '<x:xmpmeta/>')).toBe(-1);

    // The VP8X flags byte no longer claims chunks that are gone.
    expect(result.bytes[20]! & 0x0c).toBe(0);

    // …and the RIFF size field describes the file that is actually there.
    const declared = new DataView(
      result.bytes.buffer,
      result.bytes.byteOffset,
      result.bytes.byteLength,
    ).getUint32(4, true);
    expect(declared).toBe(result.bytes.length - 8);
    expect(readImageDimensions(result.bytes)).toEqual({ width: 1920, height: 1080 });
  });

  it('returns the same bytes when a WebP carries no metadata', () => {
    const webp = riff([vp8x, chunk('VP8 ', [1, 2, 3])]);
    expect(stripImageMetadata(webp, 'image/webp')!.bytes).toBe(webp);
  });

  it('refuses something that is not a WebP', () => {
    expect(stripImageMetadata(Uint8Array.from(ASCII('RIFFxxxxAVI ')), 'image/webp')).toBeNull();
  });
});

describe('readImageDimensions — the resource limit §12.8 asks for', () => {
  it('reads a decompression bomb declared size without decoding it', () => {
    // 40 bytes of file claiming 30000 x 30000: 900 million pixels, ~3.6 GB decoded. The
    // point of reading the header is that the worker refuses this before allocating any
    // of it.
    const bomb = Uint8Array.from([0xff, 0xd8, ...SOF0(30_000, 30_000), ...SCAN]);
    expect(readImageDimensions(bomb)).toEqual({ width: 30_000, height: 30_000 });
  });

  it('returns null rather than a guess when no header can be read', () => {
    expect(readImageDimensions(Uint8Array.from([0, 1, 2, 3]))).toBeNull();
    // A JPEG whose scan starts before any frame header: no size to be had.
    expect(readImageDimensions(Uint8Array.from([0xff, 0xd8, ...SCAN]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------- helpers

function indexOfPair(bytes: Uint8Array, first: number, second: number): number {
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === first && bytes[index + 1] === second) return index;
  }
  return -1;
}

function indexOfAscii(bytes: Uint8Array, text: string): number {
  const needle = ASCII(text);
  for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    if (needle.every((byte, at) => bytes[index + at] === byte)) return index;
  }
  return -1;
}

function endsWith(bytes: Uint8Array, tail: Uint8Array): boolean {
  if (tail.length > bytes.length) return false;
  const start = bytes.length - tail.length;
  return tail.every((byte, index) => bytes[start + index] === byte);
}
