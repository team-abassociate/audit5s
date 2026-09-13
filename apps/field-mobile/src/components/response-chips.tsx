import { Pressable, Text, View } from 'react-native';
import type { ResponseValue } from '@audit5s/contracts';
import { RESPONSE_TOKENS } from '@audit5s/domain';
import { createThemedStyles, useTheme } from '../lib/theme';

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
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.row}>
      {ORDER.filter((option) => option !== 'NA' || allowsNa).map((option) => {
        const token = RESPONSE_TOKENS[option]!;
        const selected = value === option;
        const color = responseColor(option, theme);
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={token.label}
            onPress={() => onChange(option)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: color },
              selected && { backgroundColor: color, borderLeftWidth: 6 },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.marks, { color: selected ? theme.color.board : color }]}>
              {token.marks === null ? 'NA' : token.marks}
            </Text>
            <Text style={[styles.label, { color: selected ? theme.color.board : color }]}>
              {token.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function responseColor(option: ResponseValue, theme: ReturnType<typeof useTheme>): string {
  if (option === 'SCORE_2') return theme.color.ok;
  if (option === 'SCORE_1') return theme.color.warn;
  if (option === 'SCORE_0') return theme.color.crit;
  return theme.color.ink3;
}

const useStyles = createThemedStyles((theme) => ({
  row: { flexDirection: 'row', gap: theme.space.sm, flexWrap: 'wrap' },
  chip: {
    flexGrow: 1,
    flexBasis: '45%',
    borderWidth: 1.5,
    paddingVertical: theme.space.sm + 2,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    // 48pt is the smallest comfortable target with gloves on, which is how this is used.
    minHeight: 56,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  marks: { fontFamily: theme.family.black, fontSize: theme.font.heading },
  label: { fontFamily: theme.family.medium, fontSize: theme.font.sm, textAlign: 'center' },
}));
