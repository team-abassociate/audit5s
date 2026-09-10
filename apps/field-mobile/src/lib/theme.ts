import { BRAND_TOKENS, RATING_BANDS } from '@audit5s/domain';

/**
 * Screen tokens.
 *
 * Brand colours come from `@audit5s/domain`, which DECISIONS.md R-6c makes the only place
 * in the codebase that hard-codes a colour — the report, the web app and this app all read
 * the same values, so they cannot drift apart.
 */
export const theme = {
  color: {
    brand: BRAND_TOKENS.maroon,
    accent: BRAND_TOKENS.orange,
    border: '#E2E2E5',
    surface: '#FFFFFF',
    background: '#F7F7F8',
    text: '#18181B',
    textMuted: '#65656D',
    danger: RATING_BANDS[3]?.color ?? '#B3261E',
    success: RATING_BANDS[0]?.color ?? '#1B7F4B',
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 6, md: 10, lg: 16 },
  font: { sm: 13, base: 15, lg: 18, xl: 24 },
} as const;
