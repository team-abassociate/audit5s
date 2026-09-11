import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { PASSWORD_MIN_LENGTH } from '@audit5s/contracts';
import { PASSWORD_REJECTION_MESSAGES, checkPassword } from '@audit5s/domain';
import { Button, ErrorBanner, Field, Heading, Muted, Screen } from '../components/ui';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { theme } from '../lib/theme';

/**
 * The forced reset (CH-1).
 *
 * The policy check runs locally first, using the same `checkPassword` from
 * `@audit5s/domain` that the API applies — so the user is told what is wrong before a
 * round trip, and the two can never disagree about what counts as acceptable.
 */
export default function ResetPasswordScreen() {
  const { user, changePassword, signOut } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const localCheck =
    newPassword.length > 0 && user
      ? checkPassword({
          password: newPassword,
          phoneE164: user.phoneE164,
          fullName: user.fullName,
          loginId: user.loginId,
        })
      : null;

  const localMessage =
    localCheck && !localCheck.ok ? PASSWORD_REJECTION_MESSAGES[localCheck.reasons[0]!] : undefined;

  const mismatch =
    confirmPassword.length > 0 && confirmPassword !== newPassword
      ? 'The two passwords do not match'
      : undefined;

  async function submit() {
    if (busy) return;
    setError(null);

    if (localMessage || mismatch) {
      setError(localMessage ?? mismatch ?? null);
      return;
    }

    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      // changePassword signs the device out: the server revokes every session on a
      // password change, so the user signs back in with the new one.
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not reach the server. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Heading>Choose a password</Heading>
          <Muted>
            Your phone number was a temporary credential only. Pick a password of at least{' '}
            {PASSWORD_MIN_LENGTH} characters that is not your name or phone number.
          </Muted>

          <ErrorBanner message={error} />

          <Field
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Your phone number"
          />

          <Field
            label="New password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoCapitalize="none"
            error={localMessage}
          />

          <Field
            label="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            error={mismatch}
            onSubmitEditing={submit}
          />

          <Button title="Set password" onPress={submit} busy={busy} />
          <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', gap: theme.space.sm },
});
