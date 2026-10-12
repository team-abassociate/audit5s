import type { UploadIntentRequest, UploadIntentResponse } from '@audit5s/contracts';
import { uuidv7 } from '@audit5s/domain';
import { api, type DeviceApi } from '@/lib/api';
import { putObject, sha256Hex } from '@/lib/photo';

/**
 * §9.4's two-phase upload from a signed-in page: intent, the PUT straight to storage, then
 * commit. The bytes never pass through the API. `blob` is the JPEG `lib/photo` made, so
 * the content type is fixed. Returns the evidence id, committed and ready to reference.
 */
export async function uploadEvidence(
  blob: Blob,
  fields: Omit<UploadIntentRequest, 'id' | 'contentType' | 'byteSize' | 'checksumSha256' | 'capturedAt'> & { id?: string },
  /** An audit's photographs go as the browser's device (R-51); anything else as the session. */
  client: Pick<DeviceApi, 'post'> = api,
): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const checksumSha256 = await sha256Hex(bytes);
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  const id = fields.id ?? uuidv7();
  const intent = await client.post<UploadIntentResponse>(
    '/evidence/upload-intent',
    { ...fields, id, contentType: 'image/jpeg', byteSize: bytes.byteLength, checksumSha256, capturedAt: new Date().toISOString() },
    id,
  );
  if (!intent.alreadyExists) await putObject(intent.uploadUrl, intent.requiredHeaders, bytes);
  await client.post(`/evidence/${intent.evidenceId}/commit`, { checksumSha256, ...size }, uuidv7());
  return intent.evidenceId;
}
