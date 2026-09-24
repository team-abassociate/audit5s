// ponytail: the legacy API, which SDK 57 still ships; move to the `File` class when the
// legacy entry point is removed. The root import throws on these methods since SDK 54.
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';

/**
 * What happens to a photograph between the shutter and SQLite (§9.4, §12.8).
 *
 * ```
 * capture (live camera)
 *   → downscale ≤1920px long edge, JPEG q80, EXIF stripped except orientation
 *     → write file to app-private storage
 *       → SQLite evidence row (LOCAL_ONLY) + outbox(media) row   [one transaction]
 * ```
 *
 * The downscale is not an optimisation. A modern phone camera produces 4–8 MB per frame,
 * an auditor takes dozens per Zone, and the upload happens on a plant's shared connection —
 * §12.8's 15 MB cap would be reached by a handful of untouched originals. At 1920 px and
 * q80 a photograph is a few hundred kilobytes and still prints at report quality (§4.1
 * requires print quality, not thumbnails).
 *
 * Re-encoding is also how EXIF goes. §12.8: "GPS is stripped from the file; it is captured
 * explicitly into columns." That matters because a photograph shared out of the system
 * should not carry coordinates the system deliberately recorded elsewhere.
 */

/** §9.4: "downscale ≤1920px long edge". */
export const MAX_LONG_EDGE_PX = 1920;
const JPEG_QUALITY = 0.8;

export interface ProcessedImage {
  uri: string;
  byteSize: number;
  width: number;
  height: number;
  checksumSha256: string;
  contentType: 'image/jpeg';
}

/**
 * Downscales, strips EXIF and hashes — in that order, so the checksum is of the bytes that
 * will actually be uploaded.
 *
 * Hashing the original instead would be subtly wrong: `commit` verifies the stored object
 * against this value, and the stored object is the re-encoded one.
 */
export async function processCapturedPhoto(
  uri: string,
  /** The frame's own size, as the camera reported it — so the resize needs no decode. */
  source?: { width: number; height: number },
): Promise<ProcessedImage> {
  const context = ImageManipulator.manipulate(uri);
  // The **long** edge, not the width: a portrait frame resized by width came out 1920×2560,
  // over §9.4's limit, and a small front-camera selfie was upscaled for nothing.
  if (source && Math.max(source.width, source.height) > MAX_LONG_EDGE_PX) {
    context.resize(
      source.width >= source.height ? { width: MAX_LONG_EDGE_PX } : { height: MAX_LONG_EDGE_PX },
    );
  } else if (!source) {
    context.resize({ width: MAX_LONG_EDGE_PX });
  }
  const image = await context.renderAsync();
  const manipulated = await image.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  const kept = await keepDurably(manipulated.uri);
  // One native read gives both the size and the bytes to hash — no base64 detour.
  const bytes = await readFileBytes(kept);

  return {
    uri: kept,
    byteSize: bytes.byteLength,
    width: manipulated.width,
    height: manipulated.height,
    checksumSha256: await sha256OfBytes(bytes),
    contentType: 'image/jpeg',
  };
}

/**
 * Moves a processed photograph out of the cache and into app-private documents.
 *
 * The manipulator writes to the cache directory, which Android is free to clear whenever
 * storage runs low. A photograph still waiting for a signal is field evidence, not a cache
 * entry: once its file is gone the upload can never succeed, and the audit it proves waits
 * for it forever.
 */
async function keepDurably(cacheUri: string): Promise<string> {
  const directory = `${FileSystem.documentDirectory}evidence/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const target = `${directory}${cacheUri.split('/').pop()}`;
  await FileSystem.moveAsync({ from: cacheUri, to: target });
  return target;
}

/**
 * SHA-256 of a file. `expo-crypto` hashes buffers rather than streams, so the file is read
 * whole; at a few hundred kilobytes that is affordable, and it is why the downscale is first.
 */
export async function sha256OfFile(uri: string): Promise<string> {
  return sha256OfBytes(await readFileBytes(uri));
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads a local file as bytes, for the hash and the presigned PUT.
 *
 * Straight into an ArrayBuffer. The base64 read it replaced pushed every photograph
 * through a character-by-character loop on the JS thread — hundreds of milliseconds per
 * photo, during which even the shutter's spinner stuttered.
 */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

