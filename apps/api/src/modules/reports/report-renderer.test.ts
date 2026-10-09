import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/env';
import type { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { ReportRenderer } from './report-renderer';

describe('ReportRenderer.printToPdf', () => {
  it('prints one page at a time, so a Kaizen sheet and a 5S report never share Chromium memory', async () => {
    const renderer = new ReportRenderer({} as ObjectStorage, {} as AppConfig);
    let inFlight = 0;
    let most = 0;
    // The browser step, replaced: it records how many prints overlap.
    (renderer as unknown as { print: (html: string) => Promise<Buffer> }).print = async (html) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (html === 'fail') throw new Error('crashed');
      return Buffer.from(html);
    };

    const results = await Promise.allSettled(['a', 'fail', 'b'].map((html) => renderer.printToPdf(html)));
    expect(most).toBe(1);
    // A failed print does not block the next one.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
