import { describe, expect, it } from 'vitest';
import { multipartBody } from './multipart';

describe('multipartBody', () => {
  it('is a form a server reads back as the same file', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x0d, 0x0a]);
    const { body, contentType } = multipartBody(
      'file',
      { bytes, name: 'Zone "list".pdf', type: 'application/pdf' },
      'boundary123',
    );

    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    // Node's FormData; React Native's types leave out `get`.
    const file = (form as unknown as { get(name: string): Blob & { name: string } }).get('file');
    expect(file.name).toBe('Zone _list_.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
});
