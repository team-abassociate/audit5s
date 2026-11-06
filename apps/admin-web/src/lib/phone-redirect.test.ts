import { describe, expect, it } from 'vitest';
import { phoneAppTarget } from './phone-redirect';

const PHONE = 'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X110) AppleWebKit/537.36 Chrome/130 Safari/537.36';

function session(chosen = false) {
  const values = new Map<string, string>(chosen ? [['leanstack.use-website', '1']] : []);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}
const visit = (userAgent: string, pathname = '/', search = '', store = session()) =>
  phoneAppTarget({ userAgent, pathname, search, session: store });

describe('phoneAppTarget', () => {
  it('sends a phone to the field app, from any portal page', () => {
    expect(visit(PHONE)).toBe('/field/');
    expect(visit(IPHONE, '/kaizen/list')).toBe('/field/');
  });

  it('leaves a computer and a tablet on the website', () => {
    expect(visit(DESKTOP)).toBeNull();
    expect(visit(TABLET)).toBeNull();
  });

  it('never moves a corrective-action link or a password reset', () => {
    expect(visit(PHONE, '/ca/abc')).toBeNull();
    expect(visit(PHONE, '/reset-password', '?token=x')).toBeNull();
  });

  it('remembers "Use the website" for the rest of the tab', () => {
    const store = session();
    expect(visit(PHONE, '/', '?website=1', store)).toBeNull();
    expect(visit(PHONE, '/reports', '', store)).toBeNull();
    expect(visit(PHONE, '/', '', session())).toBe('/field/');
  });
});
