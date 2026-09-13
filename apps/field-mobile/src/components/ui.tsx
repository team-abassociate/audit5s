import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
  type ViewProps,
} from 'react-native';
import type { ReactNode } from 'react';
import { createThemedStyles, iosHardShadow, useTheme } from '../lib/theme';

export function Screen({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={[styles.screen, style]} {...rest}>
      {children}
    </View>
  );
}

export function Card({
  children,
  style,
  ...rest
}: Omit<PressableProps, 'style'> & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.shadowShell}>
      {Platform.OS === 'android' ? (
        <View pointerEvents="none" style={[styles.hardShadow, { backgroundColor: theme.color.hard }]} />
      ) : null}
      {/* Only a Link card is one a11y element; otherwise VoiceOver must reach the inputs inside. */}
      <Pressable accessible={rest.onPress !== undefined} style={[styles.card, style]} {...rest}>{children}</Pressable>
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.heading}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.muted}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.label}>{children}</Text>;
}

export function Field({ label, error, ...rest }: TextInputProps & { label: string; error?: string }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        placeholderTextColor={theme.color.ink2}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  busy,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const styles = useStyles();
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  return (
    <View style={styles.buttonShell}>
      {Platform.OS === 'android' ? (
        <View pointerEvents="none" style={[styles.buttonShadow, { backgroundColor: theme.color.hard }]} />
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
          (pressed || busy) && styles.buttonPressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={isPrimary ? theme.color.board : theme.color.ink} />
        ) : (
          <Text style={isPrimary ? styles.buttonPrimaryText : styles.buttonSecondaryText}>{title}</Text>
        )}
      </Pressable>
    </View>
  );
}

/** A problem document rendered where the user is looking, not as a transient toast. */
export function ErrorBanner({ message }: { message: string | null }) {
  const styles = useStyles();
  const theme = useTheme();
  if (!message) return null;
  return (
    <View style={styles.bannerShell}>
      {Platform.OS === 'android' ? (
        <View pointerEvents="none" style={[styles.hardShadow, { backgroundColor: theme.color.hard }]} />
      ) : null}
      <View style={styles.banner}>
        <Text style={styles.bannerText}>{message}</Text>
      </View>
    </View>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Muted>{detail}</Muted> : null}
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.color.board, padding: theme.space.md },
  shadowShell: {
    position: 'relative',
    marginRight: 3,
    marginBottom: theme.space.sm + 3,
  },
  hardShadow: {
    position: 'absolute',
    top: 3,
    left: 3,
    right: -3,
    bottom: -3,
  },
  card: {
    backgroundColor: theme.color.tile,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
    ...iosHardShadow(theme.color.hard),
  },
  heading: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.heading,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.38,
  },
  muted: { fontFamily: theme.family.regular, fontSize: theme.font.sm, lineHeight: 20, color: theme.color.ink2 },
  label: {
    fontFamily: theme.family.medium,
    fontSize: theme.font.label,
    color: theme.color.ink3,
    marginBottom: theme.space.xs,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  field: { marginBottom: theme.space.md },
  input: {
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm + 2,
    minHeight: 48,
    fontFamily: theme.family.regular,
    fontSize: theme.font.base,
    color: theme.color.ink,
    backgroundColor: theme.color.tile2,
  },
  inputError: { borderColor: theme.color.critBand, borderLeftWidth: 4 },
  error: { fontFamily: theme.family.regular, color: theme.color.crit, fontSize: theme.font.sm, marginTop: theme.space.xs },
  buttonShell: { position: 'relative', marginRight: 2, marginBottom: 2 },
  buttonShadow: { position: 'absolute', top: 2, left: 2, right: -2, bottom: -2 },
  button: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    ...iosHardShadow(theme.color.hard, 2),
  },
  buttonPrimary: { backgroundColor: theme.color.ink },
  buttonSecondary: { backgroundColor: theme.color.tile },
  buttonPressed: { transform: [{ translateX: 2 }, { translateY: 2 }], shadowOpacity: 0 },
  buttonPrimaryText: { color: theme.color.board, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  buttonSecondaryText: { color: theme.color.ink, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  banner: {
    backgroundColor: theme.color.slip,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
    ...iosHardShadow(theme.color.hard),
  },
  bannerShell: { position: 'relative', marginRight: 3, marginBottom: theme.space.md + 3 },
  bannerText: { color: theme.color.slipInk, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  empty: { alignItems: 'center', paddingVertical: theme.space.xl, gap: theme.space.xs },
  emptyTitle: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink, textTransform: 'uppercase' },
}));
