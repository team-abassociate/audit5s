import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Button, ErrorBanner, Field, GateCard, Muted, Screen } from '../components/ui';
import { ApiError, apiBaseUrl, defaultApiBaseUrl, setApiBaseUrl } from '../lib/api';
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
  // The server this phone talks to. Hidden until asked for: an auditor never touches it,
  // and on a bench test the laptop's address changes with every Wi-Fi it joins.
  const [serverOpen, setServerOpen] = useState(false);
  const [server, setServer] = useState(apiBaseUrl());
  const [serverNote, setServerNote] = useState<string | null>(null);

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

  async function saveServer(value: string | null) {
    const saved = await setApiBaseUrl(value);
    setServer(saved);
    setServerNote(`This phone now uses ${saved}`);
    setError(null);
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
              revealable
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            <ErrorBanner message={error} />

            <Button testID="sign-in" title="Sign in" onPress={submit} busy={busy} />

            {serverOpen ? (
              <View style={styles.server}>
                <Field
                  testID="server-address"
                  label="Server address"
                  hint="The laptop running audit5s, e.g. 192.168.1.5 — its port and path are added for you."
                  value={server}
                  onChangeText={setServer}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                {serverNote ? <Muted>{serverNote}</Muted> : null}
                <Button title="Save address" variant="secondary" onPress={() => void saveServer(server)} />
                <Button
                  title="Use the built-in address"
                  variant="secondary"
                  onPress={() => void saveServer(null)}
                />
                <Muted>Built in: {defaultApiBaseUrl()}</Muted>
              </View>
            ) : (
              <View style={styles.server}>
                <Button
                  testID="server-settings"
                  title="Server address"
                  variant="secondary"
                  compact
                  onPress={() => setServerOpen(true)}
                />
              </View>
            )}
          </GateCard>
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((theme) => ({
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.space.xl },
  server: { marginTop: theme.space.md, gap: theme.space.sm },
}));
