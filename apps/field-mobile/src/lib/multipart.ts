/**
 * One file as a `multipart/form-data` body, built as bytes.
 *
 * React Native's FormData file part (`{ uri, name, type }`) never reached the server from an
 * Android phone: the Zone-list import failed with "Could not reach the server". A byte body is
 * the path photos already take to storage, so the import takes it too.
 */
export function multipartBody(
  field: string,
  file: { bytes: Uint8Array; name: string; type: string },
  boundary: string,
): { body: Uint8Array; contentType: string } {
  const name = file.name.replace(/["\r\n]/g, '_');
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + file.bytes.length + tail.length);
  body.set(head);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
