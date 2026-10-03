import type { UpdateZoneRequest, User, Zone } from '@audit5s/contracts';

/**
 * The Zone edit form's values and the PATCH it sends (U1, UX audit 2026-10-03).
 *
 * A Zone's leader is an account (`zoneLeaderId`) or, failing that, the name an auditor typed
 * (`zoneLeaderName`, R-19c / migration 0015). The form used to open on "Unassigned" for a
 * typed leader, and for an account the list had not loaded yet, and it sent every field on
 * save. It now opens on the current leader and sends only what the user changed.
 */

/** The leader select's value for "keep the typed name". It is not an account id. */
export const TYPED_LEADER = 'typed-leader';

export interface EditZoneValues {
  name: string;
  description: string;
  zoneLeaderId: string;
  defaultChecklistTemplateId: string;
}

/** The typed leader's name, when the Zone has one and no account. */
export function typedLeaderOf(zone: Zone): string | null {
  return zone.zoneLeaderId === null ? zone.zoneLeaderName : null;
}

export function editZoneDefaults(zone: Zone): EditZoneValues {
  return {
    name: zone.name,
    description: zone.description ?? '',
    zoneLeaderId: zone.zoneLeaderId ?? (typedLeaderOf(zone) ? TYPED_LEADER : ''),
    defaultChecklistTemplateId: zone.defaultChecklistTemplateId ?? '',
  };
}

/**
 * The account options. The Zone's own leader is kept even when the list lacks it — not
 * loaded yet, or no longer an active Zone Leader of the Unit — so the select never opens on
 * a value it cannot show.
 */
export function leaderAccountOptions(
  zone: Zone,
  leaders: readonly User[],
): { value: string; label: string }[] {
  const options = leaders.map((leader) => ({
    value: leader.id,
    label: `${leader.fullName} (${leader.loginId})`,
  }));
  if (zone.zoneLeaderId && !options.some((option) => option.value === zone.zoneLeaderId)) {
    options.unshift({ value: zone.zoneLeaderId, label: zone.zoneLeaderName ?? 'Current leader' });
  }
  return options;
}

/**
 * The PATCH body: only the fields the user changed. An emptied select is an explicit
 * `null`; the typed-leader option is never sent, because there is no account behind it.
 * Returns `null` when nothing changed — the API refuses an empty update.
 */
export function changedZoneFields(
  values: EditZoneValues,
  initial: EditZoneValues,
  dirty: Partial<Record<keyof EditZoneValues, boolean | undefined>>,
): Omit<UpdateZoneRequest, 'version'> | null {
  const changed = (key: keyof EditZoneValues) =>
    dirty[key] === true && values[key] !== initial[key];
  const body: Omit<UpdateZoneRequest, 'version'> = {};
  if (changed('name')) body.name = values.name;
  if (changed('description')) body.description = values.description;
  if (changed('zoneLeaderId') && values.zoneLeaderId !== TYPED_LEADER) {
    body.zoneLeaderId = values.zoneLeaderId === '' ? null : values.zoneLeaderId;
  }
  if (changed('defaultChecklistTemplateId')) {
    body.defaultChecklistTemplateId =
      values.defaultChecklistTemplateId === '' ? null : values.defaultChecklistTemplateId;
  }
  return Object.keys(body).length > 0 ? body : null;
}
