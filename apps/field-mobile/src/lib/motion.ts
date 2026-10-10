import { cubicBezier, Easing, FadeIn, ReduceMotion } from 'react-native-reanimated';
import { themes } from './theme';

/**
 * The one motion of the system, ported from `--motion` in gemba-tokens.css (GEMBA §8): 143 ms,
 * ease-out only. The only file that imports Reanimated's easing, so no screen invents a curve.
 */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
export const timing = { duration: themes.light.motion, easing: EASE_OUT, reduceMotion: ReduceMotion.System } as const;

/**
 * The same, as a Reanimated CSS transition on a style (`transitionProperty` set beside it).
 * CSS transitions do not read the reduced-motion setting: a moving one checks
 * `useReducedMotion()` itself; colour and opacity keep playing (plan 002).
 */
export const transition = {
  transitionDuration: themes.light.motion,
  transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
} as const;

/** Appearing in place: opacity only, so it plays under reduced motion too (plan 002). */
export const fadeIn = FadeIn.duration(timing.duration).easing(EASE_OUT).reduceMotion(ReduceMotion.Never);
