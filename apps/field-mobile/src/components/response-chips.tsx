import { Pressable, Text, View } from 'react-native';
import type { ResponseValue } from '@audit5s/contracts';
import { RESPONSE_TOKENS } from '@audit5s/domain';
import { createThemedStyles, useTheme } from '../lib/theme';

/**
 * The response row: 2 · 1 · 0 · NA, one tap each, as a radio group.
 *
 * Marks only on the face — the page's marking scheme says what each means, and the full
 * label (§4.1, from `RESPONSE_TOKENS`, the same table the report prints) is the accessible
 * name. Selected is a filled tile, unselected an outline: shape as well as colour.
 *
 * `NA` is hidden when the question forbids it: a question with `allows_na = false` has no
 * "not applicable" answer, and offering one only to refuse it later is the kind of small
 * dishonesty that wastes a walk across a plant.
 *
 * `readOnly` is the same principle one level up: on a finished audit the answers may not be
 * changed by anyone but a Super Admin (A-2), so the chips show what was marked and do not
 * pretend to accept a new one. A tap that saves a score the server will refuse is worse
 * than no tap — it looks like it worked.
 */
const ORDER: ResponseValue[] = ['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'];

export function ResponseChips({
  value,
  allowsNa,
  readOnly,
  onChange,
}: {
  value: ResponseValue | null;
  allowsNa: boolean;
  readOnly?: boolean;
  onChange: (value: ResponseValue) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {ORDER.filter((option) => option !== 'NA' || allowsNa).map((option) => {
        const token = RESPONSE_TOKENS[option]!;
        const selected = value === option;
        const color = responseColor(option, theme);
        const marks = token.marks === null ? 'NA' : String(token.marks);
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: Boolean(readOnly) }}
            accessibilityLabel={`${marks}, ${token.label}`}
            disabled={readOnly}
            onPress={() => onChange(option)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: color },
              selected && { backgroundColor: color },
              // Unselected marks fade out; the one that was given stays at full strength,
              // because reading it back is the whole purpose of the read-only screen.
              readOnly && !selected && styles.chipInert,
              pressed && !readOnly && styles.pressed,
            ]}
          >
            <Text style={[styles.marks, { color: selected ? theme.color.board : color }]}>{marks}</Text>
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
  return theme.color.ink2;
}

const useStyles = createThemedStyles((theme) => ({
  row: { flexDirection: 'row', gap: theme.space.sm },
  chip: {
    flex: 1,
    // Gloves on, in sunlight: bigger than the 48dp floor.
    minHeight: 52,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.tile,
  },
  chipInert: { opacity: 0.45, borderStyle: 'dashed' },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  marks: { fontFamily: theme.family.black, fontSize: 20, fontVariant: ['tabular-nums'] },
}));
