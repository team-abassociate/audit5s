/**
 * The object-storage port.
 *
 * Production is Cloudflare R2 through `@aws-sdk/client-s3` with the endpoint in an
 * environment variable (STACK.md §2), which is also what lets a local MinIO stand in
 * without a line of code changing. Nothing in this file, or anything that depends on it,
 * names a provider.
 *
 * Phase 4 adds the four verbs the two-phase media commit of §9.4 needs:
 *
 *   `presignPut`  → the URL the device PUTs to, so media never transits the API (§5)
 *   `head`        → what the server checks at commit: the object is there, and it is the
 *                   size and the checksum the intent declared
 *   `readRange`   → the first bytes, for §12.8's magic-byte sniff
 *   `presignGet`  → a ≤5-minute read URL, minted **after** the scope check (§12.6)
 *
 * `readRange` is separate from `get` deliberately. Sniffing needs twelve bytes; a report
 * render needs the whole image. Fetching a 4 MB photo to look at its first twelve bytes
 * would make every commit pay for a full download, on the request path, per photo.
 */
export interface StoredObject {
  key: string;
  byteSize: number;
  checksumSha256: string;
}

/** What `head` reports about an object that exists. */
export interface StoredObjectHead {
  key: string;
  byteSize: number;
  contentType: string | null;
  /**
   * Lowercase hex SHA-256, when the storage provider recorded one.
   *
   * Null is a real answer, not a failure: a provider that was not asked to checksum on
   * upload cannot invent one afterwards. The commit path treats null as "verify what you
   * can" — size and magic bytes — rather than as a mismatch, because rejecting a photo
   * over a missing provider feature would lose field work for an infrastructure reason.
   */
  checksumSha256: string | null;
}

export interface PresignPutOptions {
  expiresInSeconds: number;
  /** Constrains the upload: §12.6 requires the policy to pin type, size and the key. */
  contentType: string;
  byteSize: number;
  /** Recorded with the object where the provider supports it, so `head` can return it. */
  checksumSha256: string;
}

export interface PresignedUpload {
  url: string;
  /**
   * Headers the PUT must carry for the signature to verify.
   *
   * Returned rather than left for the client to reconstruct: a mismatched header fails at
   * the storage provider with an opaque 403, hours after the photo was taken and usually
   * on a device with no way to show the error.
   */
  requiredHeaders: Record<string, string>;
  expiresIn: number;
}

export interface PresignedDownload {
  url: string;
  expiresIn: number;
}

export abstract class ObjectStorage {
  abstract put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  abstract get(key: string): Promise<Buffer>;

  /** The presigned PUT of §9.4. TTL is capped at `MAX_PUT_TTL_SECONDS` by every driver. */
  abstract presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload>;

  /** The presigned GET of §12.6. TTL is capped at `MAX_GET_TTL_SECONDS`. */
  abstract presignGet(key: string, options: { expiresInSeconds: number }): Promise<PresignedDownload>;

  /** `null` when the object is not there — the "metadata without object" case of §9.4. */
  abstract head(key: string): Promise<StoredObjectHead | null>;

  /** The first `length` bytes, for magic-byte validation. `null` when absent. */
  abstract readRange(key: string, length: number): Promise<Buffer | null>;

  /** Describes where objects are going, for the startup log and `/health`. */
  abstract describe(): string;

  /**
   * Whether this driver's presigned URLs leave the API process.
   *
   * False for the filesystem driver, whose URLs are served by this application (R-9).
   * Exposed so `/health` and the startup log can say so plainly rather than leaving a
   * deployment to discover it from a bandwidth graph.
   */
  abstract get presignsOffProcess(): boolean;
}

/** §12.6: "GET TTL 300 s; PUT TTL 900 s". Capped in the port, so no driver can widen it. */
export const MAX_GET_TTL_SECONDS = 300;
export const MAX_PUT_TTL_SECONDS = 900;

export function cappedTtl(requested: number, maximum: number): number {
  return Math.max(1, Math.min(Math.floor(requested), maximum));
}
