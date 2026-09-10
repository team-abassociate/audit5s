/**
 * The object-storage port.
 *
 * Production is Cloudflare R2 through `@aws-sdk/client-s3` with the endpoint in an
 * environment variable (STACK.md §2), which is also what lets a local MinIO stand in
 * without a line of code changing. Nothing in this file, or anything that depends on it,
 * names a provider.
 *
 * Presigned URL minting is deliberately absent: media never transits the API (STACK.md
 * §5) and the presigned service arrives with evidence upload in Phase 4. What Phase 2
 * needs is to put an admin-uploaded workbook somewhere durable and read it back in the
 * worker, so that — and only that — is the port today.
 */
export interface StoredObject {
  key: string;
  byteSize: number;
  checksumSha256: string;
}

export abstract class ObjectStorage {
  abstract put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  abstract get(key: string): Promise<Buffer>;
  /** Describes where objects are going, for the startup log and `/health`. */
  abstract describe(): string;
}
