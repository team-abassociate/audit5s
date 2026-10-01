import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page, User, Zone } from '@audit5s/contracts';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from '@audit5s/contracts';
import { zoneCodeChoices, zoneCodeForNumber, zoneDisplayLabel } from '@audit5s/domain';
import { api, problemMessage } from '../lib/api';
import { createThemedStyles } from '../lib/theme';
import { Button, ConfirmAction, ErrorBanner, Field, SelectField } from './ui';

const UNASSIGNED = '__none__';

/**
 * Add or edit one Zone of a Unit — the web's Create / Edit Zone forms at phone width
 * (`UnitZones.tsx`). The number is typed and turned into the stored `Z-01` code by
 * `packages/domain`, so the phone, the web and the reports spell it the same way.
 *
 * The leader dropdown offers the Unit's Zone Leaders. A Zone with nobody to lead it yet is
 * created unassigned; adding a Zone Leader *with* this Zone (R-39) then points it at them.
 * The default checklist stays on the web: it is a Super Admin's catalogue choice.
 */
export function ZoneForm({
  unitId,
  zone,
  existing,
  onDone,
}: {
  unitId: string;
  /** Absent: a new Zone. */
  zone?: Zone;
  /** The Unit's active Zones, so a number already in use is refused before the round trip. */
  existing: readonly Zone[];
  onDone: () => void;
}) {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const taken = new Set(existing.filter((other) => other.id !== zone?.id).map((other) => other.code));
  const [zoneNumber, setZoneNumber] = useState(zone ? '' : String(firstFreeNumber(taken)));
  const [name, setName] = useState(zone?.name ?? '');
  const [description, setDescription] = useState(zone?.description ?? '');
  const [leaderId, setLeaderId] = useState<string>(zone?.zoneLeaderId ?? UNASSIGNED);
  const [numberError, setNumberError] = useState<string | undefined>();

  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders', unitId],
    queryFn: () => api.get<Page<User>>(`/users?role=ZONE_LEADER&unitId=${unitId}&limit=200`),
  });
  // INVITED leads too: a Zone leader just created has not signed in yet, and is the usual pick.
  const leaderOptions = (leaders.data?.data ?? []).filter((leader) => leader.status !== 'DISABLED');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['zones'] });
  const save = useMutation({
    mutationFn: () => {
      const leader = leaderId === UNASSIGNED ? null : leaderId;
      if (zone) {
        return api.patch<Zone>(`/zones/${zone.id}`, {
          // A Zone added by number is named just that (R-19); an emptied name goes back to it.
          name: name.trim() || zone.name,
          description: description.trim() || null,
          zoneLeaderId: leader,
          version: zone.version,
        });
      }
      const parsed = Number(zoneNumber);
      return api.post<Zone>(`/units/${unitId}/zones`, {
        code: zoneCodeForNumber(parsed),
        name: name.trim() || `Zone ${parsed}`,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(leader ? { zoneLeaderId: leader } : {}),
        sortOrder: parsed,
      });
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const archive = useMutation({
    mutationFn: () => api.post(`/zones/${zone!.id}/archive`),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  const submit = () => {
    if (!zone) {
      const parsed = Number(zoneNumber);
      if (!Number.isInteger(parsed) || parsed < ZONE_NUMBER_MIN || parsed > ZONE_NUMBER_MAX) {
        setNumberError(`Enter a number from ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}.`);
        return;
      }
      if (taken.has(zoneCodeForNumber(parsed))) {
        setNumberError('That Zone number is already used.');
        return;
      }
    }
    setNumberError(undefined);
    save.mutate();
  };

  return (
    <View style={styles.form}>
      {zone ? null : (
        <Field
          label="Zone number"
          value={zoneNumber}
          onChangeText={(text) => setZoneNumber(text.replace(/\D/g, '').slice(0, 3))}
          keyboardType="number-pad"
          maxLength={3}
          error={numberError}
          hint={`${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`}
        />
      )}
      <Field
        label="Name (optional)"
        value={name}
        onChangeText={setName}
        placeholder={zone ? zoneDisplayLabel(zone.code, zone.name) : 'e.g. Press shop'}
      />
      <Field
        label="Description (optional)"
        value={description}
        onChangeText={setDescription}
        multiline
        hint={zone ? 'Editing this never changes a completed audit.' : 'Shown to the auditor when they pick this Zone.'}
      />
      <SelectField
        label="Zone leader"
        value={leaderId}
        onChange={setLeaderId}
        options={[
          { value: UNASSIGNED, label: 'Nobody' },
          ...leaderOptions.map((leader) => ({
            value: leader.id,
            label: leader.fullName,
            detail: leader.loginId,
          })),
        ]}
      />
      <ErrorBanner message={problemMessage(save.error ?? archive.error)} />
      <Button title={zone ? 'Save changes' : 'Add Zone'} busy={save.isPending} onPress={submit} />
      <Button title="Cancel" variant="secondary" onPress={onDone} />
      {zone ? (
        <ConfirmAction
          title="Archive Zone"
          question={`Archive ${zoneDisplayLabel(zone.code, zone.name)}? Auditors stop seeing it. Its audits and corrective actions are kept.`}
          confirmLabel="Archive"
          busy={archive.isPending}
          onConfirm={() => archive.mutate()}
        />
      ) : null}
    </View>
  );
}

function firstFreeNumber(taken: Set<string>): number {
  return zoneCodeChoices().find((choice) => !taken.has(choice.code))?.number ?? ZONE_NUMBER_MIN;
}

const useStyles = createThemedStyles((theme) => ({
  form: { gap: theme.space.sm, paddingVertical: theme.space.sm },
}));
