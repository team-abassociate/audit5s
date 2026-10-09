import { describe, expect, it } from 'vitest';
import {
  createKaizenRequestSchema,
  patchKaizenRequestSchema,
  reviewKaizenRequestSchema,
} from './kaizen';

describe('kaizen contracts', () => {
  it('requires a reason to send back or reject, not to approve', () => {
    expect(reviewKaizenRequestSchema.safeParse({ decision: 'APPROVED' }).success).toBe(true);
    expect(reviewKaizenRequestSchema.safeParse({ decision: 'SENT_BACK', comment: '  ' }).success).toBe(false);
    expect(reviewKaizenRequestSchema.safeParse({ decision: 'REJECTED', comment: 'Duplicate' }).success).toBe(true);
  });

  it('refuses an empty patch, and reads a cleared field as null', () => {
    expect(patchKaizenRequestSchema.safeParse({}).success).toBe(false);
    expect(patchKaizenRequestSchema.parse({ machine: '' })).toEqual({ machine: null });
  });

  it('takes a half-filled draft', () => {
    const draft = createKaizenRequestSchema.parse({
      id: '01930000-0000-7000-8000-000000000001',
      zoneId: '01930000-0000-7000-8000-000000000002',
      theme: 'Faster changeover',
      wastes: ['WAITING_TIME'],
    });
    expect(draft.theme).toBe('Faster changeover');
  });
});
