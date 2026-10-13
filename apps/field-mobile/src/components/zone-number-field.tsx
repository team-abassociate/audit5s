import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { zoneLabelParts } from '@audit5s/domain';
import { createThemedStyles } from '../lib/theme';
import { CheckRow, Field } from './ui';

/**
 * A Zone's label (R-52) as two inputs: the number, typed on the number pad, and — only for a
 * Unit that splits its Zones into subzones (1A, 1B…) — one letter, behind a tick box. Emits
 * the joined label (`1A`), which `zoneCodeForLabel` turns into the stored code. `children`
 * (the name field) sits on the same line.
 */
export function ZoneNumberField({
  label,
  onChange,
  testID,
  children,
}: {
  label: string;
  onChange: (label: string) => void;
  testID?: string;
  children?: ReactNode;
}) {
  const styles = useStyles();
  const { number, subzone } = zoneLabelParts(label);
  const [hasSubzone, setHasSubzone] = useState(subzone !== '');
  return (
    <>
      <View style={styles.row}>
        <Field
          testID={testID}
          label="Zone no."
          value={number}
          onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 3) + (hasSubzone ? subzone : ''))}
          keyboardType="number-pad"
          maxLength={3}
          placeholder="1"
          containerStyle={styles.number}
        />
        {hasSubzone ? (
          <Field
            label="Subzone"
            value={subzone}
            onChangeText={(text) => onChange(number + text.replace(/[^a-z]/gi, '').slice(-1).toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="A"
            containerStyle={styles.subzone}
          />
        ) : null}
        {children}
      </View>
      <CheckRow
        label="This Zone has subzones"
        detail="Adds a letter after the number: 1A, 1B, 1C…"
        checked={hasSubzone}
        onChange={(checked) => {
          setHasSubzone(checked);
          if (!checked) onChange(number);
        }}
      />
    </>
  );
}

const useStyles = createThemedStyles((theme) => ({
  row: { flexDirection: 'row', gap: theme.space.sm },
  number: { width: 80 },
  subzone: { width: 72 },
}));
