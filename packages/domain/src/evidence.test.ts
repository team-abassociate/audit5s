import { describe, expect, it } from 'vitest';
import { EVIDENCE_KINDS, RESPONSE_VALUES } from '@audit5s/contracts';
import {
  ALLOWED_IMAGE_TYPES,
  canBeSummaryFlagged,
  classifyEvidence,
  classifyScore,
  evidenceObjectKey,
  isAllowedImageType,
  sniffImageType,
} from './evidence';

/**
 * Invariant E-1 as a truth table (§5.6).
 *
 * The classification decides which section of the report a photo prints in — GOOD
 * EVIDENCE or NONCONFORMITIES — and a nonconformity is what materialises a corrective
 * action in Phase 6. Getting it wrong does not produce a wrong pixel; it produces a
 * corrective action nobody was asked to close, or a missing one nobody was told about.
 */
describe('E-1 — classification is derived from the score', () => {
  it.each([
    ['SCORE_2', 'GOOD'],
    ['SCORE_1', 'NONCONFORMITY'],
    ['SCORE_0', 'NONCONFORMITY'],
    ['NA', 'NEUTRAL'],
  ] as const)('classifies question evidence at %s as %s', (value, expected) => {
    expect(classifyEvidence({ kind: 'QUESTION_EVIDENCE', scoreAtCapture: value })).toBe(expected);
  });

  it('covers every response value, so a new one cannot slip through unclassified', () => {
    for (const value of RESPONSE_VALUES) {
      expect(['GOOD', 'NONCONFORMITY', 'NEUTRAL']).toContain(classifyScore(value));
    }
  });

  it('treats a photo taken before its answer was saved as NEUTRAL, not as a failure', () => {
    // The auditor photographs first and answers a moment later. E-2 reclassifies it when
    // the response lands; until then it must not be filed as a nonconformity.
    expect(classifyEvidence({ kind: 'QUESTION_EVIDENCE', scoreAtCapture: null })).toBe('NEUTRAL');
  });

  it('ignores an auditor-supplied classification on question evidence', () => {
    // "The client may send it; the server overwrites it." A device claiming GOOD on a
    // zero-scored question is simply overruled.
    expect(
      classifyEvidence({
        kind: 'QUESTION_EVIDENCE',
        scoreAtCapture: 'SCORE_0',
        auditorSelected: 'GOOD',
      }),
    ).toBe('NONCONFORMITY');
  });

  it('honours the auditor on a walk-by photo, where there is no score to derive from', () => {
    expect(classifyEvidence({ kind: 'WALK_BY_PHOTO', auditorSelected: 'GOOD' })).toBe('GOOD');
    expect(classifyEvidence({ kind: 'WALK_BY_PHOTO', auditorSelected: 'NONCONFORMITY' })).toBe(
      'NONCONFORMITY',
    );
  });

  it('leaves an unjudged walk-by photo NEUTRAL rather than guessing', () => {
    expect(classifyEvidence({ kind: 'WALK_BY_PHOTO' })).toBe('NEUTRAL');
  });

  it.each(['AUDITOR_SELFIE', 'CORRECTIVE_AFTER'] as const)('always classifies %s NEUTRAL', (kind) => {
    // Even if a client asserts otherwise: a selfie is attendance, an after-photo is a fix.
    expect(classifyEvidence({ kind, auditorSelected: 'NONCONFORMITY' })).toBe('NEUTRAL');
  });

  it('classifies every evidence kind', () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(classifyEvidence({ kind, scoreAtCapture: 'SCORE_2' })).toBeTruthy();
    }
  });
});

describe('E-3 — only a GOOD or a NONCONFORMITY may carry the summary flag', () => {
  it('permits the two the report has sections for', () => {
    expect(canBeSummaryFlagged('GOOD')).toBe(true);
    expect(canBeSummaryFlagged('NONCONFORMITY')).toBe(true);
  });

  it('refuses NEUTRAL', () => {
    expect(canBeSummaryFlagged('NEUTRAL')).toBe(false);
  });
});

describe('the object-key convention (§5.6)', () => {
  it('puts a selfie under selfie/{unit}/{audit}', () => {
    expect(
      evidenceObjectKey({
        kind: 'AUDITOR_SELFIE',
        unitId: 'unit-1',
        auditId: 'audit-1',
        evidenceId: 'ev-1',
      }),
    ).toBe('selfie/unit-1/audit-1/ev-1.jpg');
  });

  it('puts zone evidence under evidence/{unit}/{audit}/{zone}', () => {
    expect(
      evidenceObjectKey({
        kind: 'QUESTION_EVIDENCE',
        unitId: 'unit-1',
        auditId: 'audit-1',
        auditZoneId: 'az-1',
        evidenceId: 'ev-2',
        extension: 'png',
      }),
    ).toBe('evidence/unit-1/audit-1/az-1/ev-2.png');
  });

  it('starts every key with the Unit after its prefix, so a per-Unit export is a prefix scan', () => {
    const key = evidenceObjectKey({
      kind: 'WALK_BY_PHOTO',
      unitId: 'unit-9',
      auditId: 'audit-9',
      auditZoneId: 'az-9',
      evidenceId: 'ev-9',
    });
    expect(key.split('/')[1]).toBe('unit-9');
  });
});

describe('§12.8 — the bytes have to be the image type they claim to be', () => {
  it('accepts exactly the three types the policy allows', () => {
    expect(Object.keys(ALLOWED_IMAGE_TYPES).sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(isAllowedImageType('image/gif')).toBe(false);
    expect(isAllowedImageType('application/zip')).toBe(false);
  });

  it('sniffs a JPEG', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
  });

  it('sniffs a PNG', () => {
    expect(
      sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
  });

  it('sniffs a WebP, which needs both the RIFF header and the WEBP tag', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffImageType(webp)).toBe('image/webp');

    // RIFF alone is a container tag — WAV files carry it too, and a WAV is not an image.
    const riffOnly = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(riffOnly)).toBeNull();
  });

  it('rejects a file that only claims to be an image', () => {
    // A ZIP renamed to .jpg with `content-type: image/jpeg`: the presigned policy accepted
    // the claim, and this is the check that catches the bytes.
    expect(sniffImageType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});
