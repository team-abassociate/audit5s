import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Unit } from '@audit5s/contracts';
import { api, problemMessage } from '../lib/api';
import { createThemedStyles } from '../lib/theme';
import { Button, Card, CardHeader, ErrorBanner, Field } from './ui';

/**
 * Create or edit a Unit. The same fields as the web's Unit form, minus the map pin and
 * geofence, which want a map and belong on the web.
 *
 * `canRename` is false for a Coordinator (U-1, §6.3): the name is shown but not editable, and
 * is left out of the update so the server's FIELD_NOT_EDITABLE is never provoked.
 */
export function UnitForm({
  unit,
  canRename = true,
  onSaved,
  onCancel,
}: {
  unit?: Unit;
  canRename?: boolean;
  onSaved: (unit: Unit) => void;
  onCancel?: () => void;
}) {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: unit?.name ?? '',
    address: unit?.address ?? '',
    city: unit?.city ?? '',
    state: unit?.state ?? '',
    postalCode: unit?.postalCode ?? '',
    contactName: unit?.contactName ?? '',
    contactPhone: unit?.contactPhone ?? '',
    contactEmail: unit?.contactEmail ?? '',
  });
  const set = (key: keyof typeof values) => (text: string) =>
    setValues((current) => ({ ...current, [key]: text }));

  const save = useMutation({
    mutationFn: () => {
      const trimmed = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, value.trim()]),
      ) as typeof values;
      if (unit) {
        // An emptied field clears it (`clearable` on the wire); `version` guards a stale edit.
        const { name, ...rest } = trimmed;
        return api.patch<Unit>(`/units/${unit.id}`, {
          ...(canRename ? { name } : {}),
          ...Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, value || null])),
          version: unit.version,
        });
      }
      return api.post<Unit>(
        '/units',
        Object.fromEntries(Object.entries(trimmed).filter(([, value]) => value !== '')),
      );
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['units'] });
      await queryClient.invalidateQueries({ queryKey: ['unit', saved.id] });
      onSaved(saved);
    },
  });

  return (
    <Card>
      <CardHeader title={unit ? 'Edit details' : 'Unit details'} />
      <Field
        label="Name"
        value={values.name}
        onChangeText={set('name')}
        placeholder="e.g. Chakan Plant 2"
        editable={canRename}
        hint={canRename ? undefined : 'Only a Super Admin can rename a Unit.'}
      />
      <Field label="Address (optional)" value={values.address} onChangeText={set('address')} multiline />
      <Field label="City (optional)" value={values.city} onChangeText={set('city')} />
      <Field label="State (optional)" value={values.state} onChangeText={set('state')} />
      <Field label="Postal code (optional)" value={values.postalCode} onChangeText={set('postalCode')} keyboardType="number-pad" />
      <Field label="Contact name (optional)" value={values.contactName} onChangeText={set('contactName')} />
      <Field
        label="Contact phone (optional)"
        hint="With the country code, e.g. +919876543210"
        value={values.contactPhone}
        onChangeText={set('contactPhone')}
        keyboardType="phone-pad"
      />
      <Field
        label="Contact email (optional)"
        value={values.contactEmail}
        onChangeText={set('contactEmail')}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <ErrorBanner message={problemMessage(save.error)} />
      <View style={styles.actions}>
        <Button
          title={unit ? 'Save changes' : 'Create Unit'}
          busy={save.isPending}
          disabled={values.name.trim() === ''}
          onPress={() => save.mutate()}
        />
        {onCancel ? <Button title="Cancel" variant="secondary" onPress={onCancel} /> : null}
      </View>
    </Card>
  );
}

const useStyles = createThemedStyles((theme) => ({
  actions: { gap: theme.space.sm },
}));
