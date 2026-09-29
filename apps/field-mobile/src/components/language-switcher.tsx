import { Pressable, Text, View } from 'react-native';
import { APP_LANGUAGES, LANGUAGE_ENGLISH_NAMES, LANGUAGE_NAMES } from '../lib/language';
import { useLanguage } from '../lib/language-provider';
import { createThemedStyles } from '../lib/theme';
import { Label } from './ui';

/**
 * The checklist language, as three side-by-side options: English · हिन्दी · मराठी.
 *
 * One component for every place it appears (Overview, Profile), so the two can never show
 * different choices — both read and write the same per-person setting.
 *
 * `Segmented`'s look — an ink-ruled strip, the chosen option filled in ink, shape as well
 * as colour — but a radio group rather than tabs, because this is a setting and not a view
 * of a list, and 48px tall rather than 44 because it is a touch target in its own right.
 *
 * Each language is named in its own script, so an operator who reads no English still
 * finds theirs; the label above says "Language" in both scripts for the same reason.
 */
export function LanguageSwitcher({ showLabel = true }: { showLabel?: boolean }) {
  const styles = useStyles();
  const { language, choose } = useLanguage();

  return (
    <View>
      {showLabel ? <Label>Checklist language · भाषा</Label> : null}
      <View style={styles.strip} accessibilityRole="radiogroup" accessibilityLabel="Checklist language">
        {APP_LANGUAGES.map((option, index) => {
          const selected = option === language;
          return (
            <Pressable
              key={option}
              testID={`language-${option}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={
                option === 'en'
                  ? LANGUAGE_NAMES[option]
                  : `${LANGUAGE_NAMES[option]}, ${LANGUAGE_ENGLISH_NAMES[option]}`
              }
              onPress={() => choose(option)}
              style={({ pressed }) => [
                styles.option,
                index > 0 && styles.divider,
                selected && styles.selected,
                pressed && !selected && styles.pressed,
              ]}
            >
              <Text numberOfLines={1} style={[styles.text, selected && styles.textSelected]}>
                {LANGUAGE_NAMES[option]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  strip: {
    flexDirection: 'row',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
  },
  option: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  divider: { borderLeftWidth: 1.5, borderLeftColor: theme.color.edge },
  selected: { backgroundColor: theme.color.ink },
  pressed: { backgroundColor: theme.color.tile2 },
  text: { fontFamily: theme.family.medium, fontSize: 14, color: theme.color.ink2 },
  textSelected: { color: theme.color.board },
}));
