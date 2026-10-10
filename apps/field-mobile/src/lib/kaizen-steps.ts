import type { KaizenFields, KaizenMissingItem } from '@audit5s/contracts';
import { missingKaizenItems } from '@audit5s/domain';
import { KAIZEN_STEPS, type KaizenStep } from './kaizen-strings';

/**
 * The Kaizen form's twelve steps as data (plans/kaizen-ux-plan.md 2.1, 2.2, 2.6): which
 * missing item belongs to which step, each step's state, and the footer's count. Pure, so
 * the count is tested against `missingKaizenItems`, the rule the server will hold to.
 */

/** Which sheet items each step holds, in screen order. */
export const STEP_ITEMS: Record<KaizenStep, readonly (keyof KaizenFields | 'beforePhoto' | 'afterPhoto')[]> = {
  details: ['machine', 'lineArea', 'implementedOn'],
  team: ['teamMembers'],
  theme: ['theme', 'target'],
  problem: ['problem5w1h'],
  countermeasure: ['countermeasure'],
  before: ['beforePhoto'],
  after: ['afterPhoto'],
  wastes: ['wastes'],
  parameters: ['parameters'],
  horizontal: ['horizontalDeployment'],
  benefits: ['benefits', 'annualSaving'],
  people: ['rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy'],
};

const REQUIRED: ReadonlySet<string> = new Set(missingKaizenItems({}, { before: false, after: false }));

export type StepState = 'done' | 'required' | 'optional';
export interface Photos {
  before: boolean;
  after: boolean;
}

/** The step a missing item is in. */
export function stepOf(item: KaizenMissingItem): KaizenStep {
  return KAIZEN_STEPS.find((step) => STEP_ITEMS[step].includes(item))!;
}

/**
 * `done` when the step's required items are all there (an optional step: when anything in it
 * is filled), `required` while one is missing, `optional` for an empty optional step.
 */
export function stepState(step: KaizenStep, missing: ReadonlySet<string>, sheet: KaizenFields): StepState {
  const items = STEP_ITEMS[step];
  const required = items.filter((item) => REQUIRED.has(item));
  if (required.length > 0) return required.some((item) => missing.has(item)) ? 'required' : 'done';
  const filled = items.some((item) => {
    const value = sheet[item as keyof KaizenFields];
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
  });
  return filled ? 'done' : 'optional';
}

/** The footer: steps done of twelve, and required steps still open. */
export function formProgress(sheet: KaizenFields, photos: Photos) {
  const missing = new Set<string>(missingKaizenItems(sheet, photos));
  const states = KAIZEN_STEPS.map((step) => stepState(step, missing, sheet));
  return {
    missing,
    states,
    done: states.filter((state) => state === 'done').length,
    total: KAIZEN_STEPS.length,
    requiredLeft: states.filter((state) => state === 'required').length,
  };
}
