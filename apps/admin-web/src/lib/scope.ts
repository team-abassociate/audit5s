import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMatches, useNavigate, useRouterState } from '@tanstack/react-router';
import type { Page, Unit } from '@audit5s/contracts';
import { api } from './api';
import { useSession } from './session';

/**
 * The portal's one Unit scope (UX audit G4).
 *
 * Which Unit a screen covers is a single value for the whole portal: it lives in the URL as
 * `?unit=<id>` (so a link, a reload, Back and Forward all keep it), rides along on every
 * navigation (`retainSearchParams` on the gated route), and is remembered per browser for
 * the next visit. The shell draws the one picker; a screen only reads the answer.
 *
 * A route says whether it is scoped with `staticData.unitScope`:
 * - `'one'`: the screen needs exactly one Unit (the board, Unit analytics);
 * - `'any'`: the screen can also cover every Unit at once — offered only to an
 *   organization-wide role (a Super Admin), as "All Units";
 * - absent: the screen is not filtered by Unit, so no picker is shown and the value is just
 *   carried through to the next screen that is.
 *
 * A Coordinator holds exactly one Unit (M-1, R-42), so for them the scope is fixed and the
 * picker is a plain label. The server still decides what anyone may read: an id in the URL
 * that is not in `/units` (which the API already narrows to the caller's scope) is ignored.
 */

export type UnitScopeMode = 'one' | 'any';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Whether this screen is filtered by the portal's Unit scope, and how. */
    unitScope?: UnitScopeMode;
  }
}

/** The `?unit=` value meaning every Unit the caller can see. */
export const ALL_UNITS = 'all';

export interface ScopeSearch {
  unit?: string;
}

export function validateScopeSearch(search: Record<string, unknown>): ScopeSearch {
  return { unit: typeof search.unit === 'string' && search.unit !== '' ? search.unit : undefined };
}

/** Last choice, including "All Units". */
const KEY_SCOPE = 'audit5s-unit';
/** Last single Unit, so a one-Unit screen opened after "All Units" lands where you were. */
const KEY_UNIT = 'audit5s-unit-last';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage refused: the URL still carries the scope, only the next visit forgets it.
  }
}

/** Keeps a scope for this browser's next visit. */
export function rememberScope(id: string): void {
  write(KEY_SCOPE, id);
  if (id !== ALL_UNITS) write(KEY_UNIT, id);
}

/** The Units the caller can see. Same query key as the screens use, so it is fetched once. */
export function useUnits() {
  return useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
    staleTime: 5 * 60_000,
  });
}

/** The scope mode of the deepest route that declares one. */
export function useUnitScopeMode(): UnitScopeMode | undefined {
  return useMatches({
    select: (matches) => matches.findLast((match) => match.staticData?.unitScope)?.staticData.unitScope,
  });
}

export interface UnitScope {
  /** How the current screen uses the scope; `undefined` when it does not. */
  mode: UnitScopeMode | undefined;
  /** False until the Unit list has arrived; nothing below is meaningful before then. */
  ready: boolean;
  /** The Unit in scope, or `null` for "All Units". `''` before `ready` or with no Units. */
  unitId: string | null;
  unit: Unit | undefined;
  units: Unit[];
  /** "All Units" may be offered on this screen. */
  allowAll: boolean;
  /** One Unit and nothing to choose (a Coordinator). */
  fixed: boolean;
  /** The value the URL should hold for this screen, to normalise it. */
  canonical: string | undefined;
  setUnit: (id: string) => void;
}

/**
 * The Unit a screen shows: `null` for "All Units", `''` when the caller sees no Unit.
 *
 * `wanted` is the URL's value, else this browser's last choice. A Unit the caller cannot
 * see (an old link, another person's last choice) is never used: the last single Unit, then
 * the first, stands in. With nothing asked for, a screen that allows "All Units" shows all.
 */
export function resolveUnitScope(input: {
  wanted: string | null | undefined;
  last: string | null | undefined;
  unitIds: string[];
  allowAll: boolean;
}): string | null {
  const { wanted, last, unitIds, allowAll } = input;
  if (wanted === ALL_UNITS && allowAll) return null;
  if (wanted && unitIds.includes(wanted)) return wanted;
  if ((wanted === undefined || wanted === null) && allowAll) return null;
  if (last && unitIds.includes(last)) return last;
  return unitIds[0] ?? '';
}

/**
 * Resolves the scope for the current screen. Order: the URL, then this browser's last
 * choice, then the first Unit (or "All Units" where that is allowed).
 */
export function useUnitScope(): UnitScope {
  const { scope } = useSession();
  const mode = useUnitScopeMode();
  // The location, not the matches: the matches' search lags a navigation by a render, and the
  // shell's canonicalising effect would read the old Unit and put it back.
  const wantedUnit = useRouterState({
    select: (s) => validateScopeSearch(s.location.search as Record<string, unknown>).unit,
  });
  const navigate = useNavigate();
  const query = useUnits();
  const units = useMemo(() => query.data?.data ?? [], [query.data]);
  const organizationWide = scope?.organizationWide ?? false;
  const allowAll = organizationWide && mode === 'any';

  const resolved = useMemo(
    () =>
      resolveUnitScope({
        wanted: wantedUnit ?? read(KEY_SCOPE),
        last: read(KEY_UNIT),
        unitIds: units.map((unit) => unit.id),
        allowAll,
      }),
    [wantedUnit, units, allowAll],
  );

  const setUnit = useCallback(
    (id: string) => {
      if (!id) return;
      rememberScope(id);
      void navigate({ to: '.', search: ((prev: ScopeSearch) => ({ ...prev, unit: id })) as never });
    },
    [navigate],
  );

  const ready = query.isSuccess;
  const unitId = ready ? resolved : '';
  return {
    mode,
    ready,
    unitId,
    unit: unitId ? units.find((unit) => unit.id === unitId) : undefined,
    units,
    allowAll,
    fixed: !organizationWide && units.length === 1,
    canonical: !ready || mode === undefined ? undefined : unitId === null ? ALL_UNITS : unitId || undefined,
    setUnit,
  };
}

/** The scope's name as a title or a label reads it. */
export function scopeName(scope: UnitScope): string | undefined {
  if (!scope.ready || scope.mode === undefined) return undefined;
  return scope.unitId === null ? 'All Units' : scope.unit?.name;
}
