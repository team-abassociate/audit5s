/**
 * R-86: a phone opening the portal goes to the field app at `/field`. Its "Use the website"
 * button comes back with `?website=1`, which holds for that browser tab, so nobody is sent away
 * mid-task and the next visit starts in the app again.
 */
const WEBSITE_PARAM = 'website';
const WEBSITE_CHOSEN = 'leanstack.use-website';
/** Links people receive on a phone, which the app does not answer at these addresses. */
const STAYS_ON_WEBSITE = ['/ca/', '/reset-password'];

interface Place {
  userAgent: string;
  pathname: string;
  search: string;
  session: Pick<Storage, 'getItem' | 'setItem'>;
}

/** Where to send this visit, or null to stay. Records the choice to use the website. */
export function phoneAppTarget({ userAgent, pathname, search, session }: Place): string | null {
  if (new URLSearchParams(search).get(WEBSITE_PARAM) === '1') {
    session.setItem(WEBSITE_CHOSEN, '1');
    return null;
  }
  // "Mobi" is every phone browser's own mark, and no tablet's or desktop's by default.
  if (!/Mobi/i.test(userAgent)) return null;
  if (session.getItem(WEBSITE_CHOSEN) === '1') return null;
  if (STAYS_ON_WEBSITE.some((prefix) => pathname.startsWith(prefix))) return null;
  return '/field/';
}
