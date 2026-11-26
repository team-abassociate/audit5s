import { useEffect, useState } from 'react';
import { zoneLabelFromCode } from '@audit5s/domain';
import { problemMessage } from '../lib/api';
import {
  deviceLabel,
  movesWithoutSignOut,
  useAuditsElsewhere,
  useContinueHere,
  type AuditElsewhere,
} from '../lib/audits-elsewhere';
import { formatDateTime } from '../lib/format';
import { useResumeAudit } from '../lib/resume-audit';
import { useSession } from '../lib/session';
import { ChoiceDialog, SlipStack } from './ui';

/** The pop-up opens by itself once per launch; after "Not now" the slip stays to tap. */
let askedThisLaunch = false;

/**
 * R-92: the auditor's open audits that another device holds, and the way to bring them here.
 *
 * A slip on the Overview names them. For a Consultant or Zone Leader still signed in on the
 * other device, the question also opens by itself after sign-in: their audit moves only once
 * that device is signed out, and the button here does that. A Super Admin or Coordinator is
 * asked only whether to continue here.
 */
export function AuditsElsewhere() {
  const { user } = useSession();
  const elsewhere = useAuditsElsewhere();
  const continueHere = useContinueHere();
  const resume = useResumeAudit();
  const [open, setOpen] = useState(false);

  const items = elsewhere.data ?? [];
  const mustSignOut = !movesWithoutSignOut(user?.role) && items.some((item) => item.stillSignedIn);

  useEffect(() => {
    if (mustSignOut && !askedThisLaunch) {
      askedThisLaunch = true;
      setOpen(true);
    }
  }, [mustSignOut]);

  if (items.length === 0) return null;

  const devices = [...new Set(items.map((item) => deviceLabel(item.device)))];
  const where = devices.length === 1 ? devices[0]! : 'other devices';
  const count = items.length === 1 ? 'An audit' : `${items.length} audits`;

  const confirm = () =>
    continueHere.mutate(items, {
      onSuccess: () => {
        setOpen(false);
        // One audit goes straight back to the question it stopped on.
        if (items.length === 1) {
          const { audit } = items[0]!;
          resume.mutate({ id: audit.id, status: audit.status, auditType: audit.auditType });
        }
      },
    });

  return (
    <>
      <SlipStack
        rows={[
          {
            tone: 'slip',
            title: `${count} of yours ${items.length === 1 ? 'is' : 'are'} open on ${where}`,
            detail: mustSignOut ? 'Sign out of it to continue here.' : 'Tap to continue here.',
            onPress: () => setOpen(true),
          },
        ]}
      />
      <ChoiceDialog
        visible={open}
        title={mustSignOut ? `Sign out of ${where}?` : 'Continue here?'}
        message={message(items, where, mustSignOut)}
        confirmLabel={mustSignOut ? 'Sign out and continue here' : 'Continue here'}
        cancelLabel="Not now"
        busy={continueHere.isPending || resume.isPending}
        error={continueHere.error ? problemMessage(continueHere.error) : null}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

function message(items: readonly AuditElsewhere[], where: string, mustSignOut: boolean): string {
  const list = items.map(describe).join('\n');
  const synced = items
    .map((item) => item.device?.lastSyncAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const lastSync = synced ? ` It last uploaded at ${formatDateTime(synced)}.` : '';
  const lead = mustSignOut
    ? `You are still signed in on ${where}, where this work is open:`
    : `This work was left open on ${where}:`;
  const consequence = mustSignOut
    ? `Signing out there brings it to this device, with every answer and photo it uploaded.${lastSync} Anything it has not uploaded yet stays behind, held for review.`
    : `Continuing here brings it to this device, with every answer and photo uploaded so far, and ${where} can no longer change it.${lastSync} Anything not yet uploaded from there stays behind, held for review.`;
  return `${lead}\n${list}\n\n${consequence}`;
}

function describe({ audit }: AuditElsewhere): string {
  const zones = (audit.zoneCodes ?? []).map((code) => {
    const label = zoneLabelFromCode(code);
    return label ? `Zone ${label}` : code;
  });
  const state = audit.status === 'PAUSED' ? 'paused' : 'in progress';
  return `• ${audit.unitName}${zones.length ? `, ${zones.join(', ')}` : ''} (${state})`;
}
