import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewProps,
} from 'react-native';
import type { ReactNode } from 'react';
import { theme } from '../lib/theme';

export function Screen({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  return (
    <View style={[styles.screen, style]} {...rest}>
      {children}
    </View>
  );
}

export function Card({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  return (
    <View style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Field({ label, error, ...rest }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        placeholderTextColor={theme.color.textMuted}
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
  const isPrimary = variant === 'primary';
  return (
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
        <ActivityIndicator color={isPrimary ? '#FFFFFF' : theme.color.brand} />
      ) : (
        <Text style={isPrimary ? styles.buttonPrimaryText : styles.buttonSecondaryText}>{title}</Text>
      )}
    </Pressable>
  );
}

/** A problem document rendered where the user is looking, not as a transient toast. */
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{message}</Text>
    </View>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Muted>{detail}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.background, padding: theme.space.md },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    padding: theme.space.md,
    marginBottom: theme.space.sm,
  },
  heading: { fontSize: theme.font.xl, fontWeight: '700', color: theme.color.text },
  muted: { fontSize: theme.font.sm, color: theme.color.textMuted },
  label: { fontSize: theme.font.sm, fontWeight: '600', color: theme.color.textMuted, marginBottom: theme.space.xs },
  field: { marginBottom: theme.space.md },
  input: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm + 2,
    fontSize: theme.font.base,
    color: theme.color.text,
    backgroundColor: theme.color.surface,
  },
  inputError: { borderColor: theme.color.danger },
  error: { color: theme.color.danger, fontSize: theme.font.sm, marginTop: theme.space.xs },
  button: {
    borderRadius: theme.radius.sm,
    paddingVertical: theme.space.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonPrimary: { backgroundColor: theme.color.brand },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.color.border },
  buttonPressed: { opacity: 0.75 },
  buttonPrimaryText: { color: '#FFFFFF', fontWeight: '600', fontSize: theme.font.base },
  buttonSecondaryText: { color: theme.color.brand, fontWeight: '600', fontSize: theme.font.base },
  banner: {
    backgroundColor: '#FCE7E5',
    borderRadius: theme.radius.sm,
    padding: theme.space.md,
    marginBottom: theme.space.md,
  },
  bannerText: { color: '#B3261E', fontSize: theme.font.sm },
  empty: { alignItems: 'center', paddingVertical: theme.space.xl, gap: theme.space.xs },
  emptyTitle: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
});
