import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View, StyleSheet } from 'react-native';
import { Button, ErrorBanner, Field, Heading, Muted, Screen } from '../components/ui';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { theme } from '../lib/theme';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(loginId, password);
    } catch (cause) {
      // Anything that is not an ApiError is reported as a connection problem, which is the
      // right words for an auditor in a plant and the wrong ones for whoever has to debug
      // it: a missing global `crypto` read exactly like a dead network. The cause is kept.
      if (!(cause instanceof ApiError)) console.error('sign-in failed', cause);
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandMark}>5S</Text>
            <Heading>Field audit</Heading>
            <Muted>Sign in with the login ID your administrator gave you.</Muted>
          </View>

          <ErrorBanner message={error} />

          <Field
            label="Login ID"
            value={loginId}
            onChangeText={setLoginId}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="RA3210"
            textContentType="username"
            returnKeyType="next"
          />

          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          <Button title="Sign in" onPress={submit} busy={busy} />

          <Muted>
            Signing in for the first time? Your password is your phone number, and you will be
            asked to change it straight away.
          </Muted>
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', gap: theme.space.sm },
  brand: { alignItems: 'center', marginBottom: theme.space.xl, gap: theme.space.xs },
  brandMark: {
    backgroundColor: theme.color.accent,
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: theme.font.xl,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    marginBottom: theme.space.sm,
  },
});
