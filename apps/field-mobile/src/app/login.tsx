import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Button, ErrorBanner, Field, GateCard, Screen } from '../components/ui';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { createThemedStyles } from '../lib/theme';

/** One tile on the dry-erase ground — the admin web's gate card, at phone width. */
export default function LoginScreen() {
  const styles = useStyles();
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
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen bare>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <GateCard>
            <Field
              testID="login-id"
              label="Login ID"
              hint="Issued when your account was created, e.g. RA3210"
              value={loginId}
              onChangeText={setLoginId}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="username"
              placeholder="RA3210"
              textContentType="username"
              returnKeyType="next"
            />

            <Field
              testID="password"
              label="Password"
              hint="First time? Your password is your phone number, and you will be asked to change it straight away."
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            <ErrorBanner message={error} />

            <Button testID="sign-in" title="Sign in" onPress={submit} busy={busy} />
          </GateCard>
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((theme) => ({
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.space.xl },
}));
