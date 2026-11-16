import type { Transition } from 'motion/react';

/**
 * Motion (`motion/react`) is used for exits and layout slides only (DECISIONS R-85).
 * It holds no timings of its own: they are read from ledger-tokens.css (LEDGER rule 1),
 * the way `useToken()` reads colours for Recharts.
 */

/** "120ms" → 0.12, "0.2s" → 0.2; anything else → 0 (instant). */
export function seconds(value: string): number {
  const match = /^([\d.]+)(ms|s)$/.exec(value.trim());
  if (!match) return 0;
  const n = Number(match[1]);
  return match[2] === 'ms' ? n / 1000 : n;
}

/** "cubic-bezier(.23,1,.32,1)" → [0.23, 1, 0.32, 1]; anything else → undefined. */
export function bezier(value: string): [number, number, number, number] | undefined {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value.trim());
  const parts = match?.[1]?.split(',').map(Number);
  return parts?.length === 4 && parts.every(Number.isFinite) ? (parts as [number, number, number, number]) : undefined;
}

let cached: { micro: Transition; short: Transition } | undefined;

/**
 * The two Ledger timings (rule 9) as Motion transitions.
 * `micro`: exits and the segmented-control pill. `short`: entrances and layout slides.
 * Durations do not change with the theme, so they are read once.
 */
export function ledgerMotion(): { micro: Transition; short: Transition } {
  if (cached) return cached;
  const style = getComputedStyle(document.documentElement);
  // 'easeOut' is Motion's named curve, used only if the token can't be read; not a Ledger value.
  const ease = bezier(style.getPropertyValue('--ease-out')) ?? 'easeOut';
  const make = (token: string): Transition => ({ duration: seconds(style.getPropertyValue(token)), ease });
  cached = { micro: make('--dur-micro'), short: make('--dur-short') };
  return cached;
}
