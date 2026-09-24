import { describe, expect, it } from 'vitest';
import { reachableUploadUrl } from './upload-url';

const signed = 'http://127.0.0.1:3000/api/v1/_local-objects/evidence%2Fa.jpg?expires=1&sig=abc';

describe('reachableUploadUrl', () => {
  it('points a loopback upload at the host the app reaches the API on, keeping the signature', () => {
    expect(reachableUploadUrl(signed, 'http://10.0.2.2:3000/api/v1')).toBe(
      'http://10.0.2.2:3000/api/v1/_local-objects/evidence%2Fa.jpg?expires=1&sig=abc',
    );
  });

  it('leaves a real object store address untouched', () => {
    const s3 = 'https://objects.example.com/bucket/evidence/a.jpg?X-Amz-Signature=abc';
    expect(reachableUploadUrl(s3, 'https://api.example.com/api/v1')).toBe(s3);
  });
});
