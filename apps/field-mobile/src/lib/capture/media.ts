// ponytail: the legacy API, which SDK 57 still ships; move to the `File` class when the
// legacy entry point is removed. The root import throws on these methods since SDK 54.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
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
export async function processCapturedPhoto(uri: string): Promise<ProcessedImage> {
  const manipulated = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: MAX_LONG_EDGE_PX } }],
    {
      compress: JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );

  const info = await FileSystem.getInfoAsync(manipulated.uri);
  const byteSize = info.exists && 'size' in info ? (info.size ?? 0) : 0;

  return {
    uri: manipulated.uri,
    byteSize,
    width: manipulated.width,
    height: manipulated.height,
    checksumSha256: await sha256OfFile(manipulated.uri),
    contentType: 'image/jpeg',
  };
}

/**
 * SHA-256 of a file, computed from its base64 form.
 *
 * `expo-crypto` hashes strings rather than streams, so the file is read once as base64 and
 * hashed as bytes. At a few hundred kilobytes that is affordable; it is the reason the
 * downscale happens first.
 */
export async function sha256OfFile(uri: string): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return sha256OfBase64(base64);
}

export async function sha256OfBase64(base64: string): Promise<string> {
  const bytes = decodeBase64(base64);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads a local file as bytes, for the presigned PUT. */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return decodeBase64(base64);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
