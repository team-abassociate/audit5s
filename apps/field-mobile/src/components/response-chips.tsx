import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ResponseValue } from '@audit5s/contracts';
import { RESPONSE_TOKENS } from '@audit5s/domain';
import { theme } from '../lib/theme';

/**
 * The four response chips (§4.1's response labels, from `packages/domain`).
 *
 * Labels and colours come from `RESPONSE_TOKENS`, the same table the report renders from
 * (R-6c), so the chip an auditor taps and the words printed on the PDF cannot drift.
 *
 * `NA` is hidden when the question forbids it: a question with `allows_na = false` has no
 * "not applicable" answer, and offering one only to refuse it later is the kind of small
 * dishonesty that wastes a walk across a plant.
 */
const ORDER: ResponseValue[] = ['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'];

export function ResponseChips({
  value,
  allowsNa,
  onChange,
}: {
  value: ResponseValue | null;
  allowsNa: boolean;
  onChange: (value: ResponseValue) => void;
}) {
  return (
    <View style={styles.row}>
      {ORDER.filter((option) => option !== 'NA' || allowsNa).map((option) => {
        const token = RESPONSE_TOKENS[option]!;
        const selected = value === option;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={token.label}
            onPress={() => onChange(option)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: token.color },
              selected && { backgroundColor: token.color },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.marks, { color: selected ? '#FFFFFF' : token.color }]}>
              {token.marks === null ? 'NA' : token.marks}
            </Text>
            <Text style={[styles.label, { color: selected ? '#FFFFFF' : token.color }]}>
              {token.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: theme.space.sm, flexWrap: 'wrap' },
  chip: {
    flexGrow: 1,
    flexBasis: '45%',
    borderWidth: 1.5,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.space.sm + 2,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    // 48pt is the smallest comfortable target with gloves on, which is how this is used.
    minHeight: 56,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  marks: { fontSize: theme.font.lg, fontWeight: '700' },
  label: { fontSize: theme.font.sm, fontWeight: '600', textAlign: 'center' },
});
