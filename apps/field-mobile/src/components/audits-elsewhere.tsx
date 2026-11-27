import { useEffect, useState } from 'react';
import { groupAuditsByUnit, zoneLabelFromCode, zonesLine } from '@audit5s/domain';
import { problemMessage } from '../lib/api';
import {
  deviceLabel,
  movesWithoutSignOut,
  useAuditsElsewhere,
  useContinueHere,
  type AuditElsewhere,
} from '../lib/audits-elsewhere';
import { formatDateTime } from '../lib/format';
import { AUDIT_TYPE_LABELS } from '../lib/labels';
import { useResumeAudit } from '../lib/resume-audit';
import { useSession } from '../lib/session';
import { AuditGroupList } from './audit-groups';
import { CheckRow, ChoiceDialog, SlipStack } from './ui';

/** The pop-up opens by itself once per launch; after "Not now" the slip stays to tap. */
let askedThisLaunch = false;

/**
 * R-92: the auditor's open audits that another device holds, and the way to bring them here.
 *
 * A slip on the Overview names them. For a Consultant or Zone Leader still signed in on the
 * other device, the question also opens by itself after sign-in: their audit moves only once
 * that device is signed out, and the button here does that. A Super Admin or Coordinator is
 * asked only whether to continue here.
 *
 * With more than one, the auditor ticks which to bring here; nothing is ticked to begin with.
 * The rest stay where they are. Signing out of a device leaves its audits' locks alone and
 * never wipes its unsynced work (§9.7), so an audit left behind on a signed-out phone carries
 * on there once they sign back in.
 */
export function AuditsElsewhere() {
  const { user } = useSession();
  const elsewhere = useAuditsElsewhere();
  const continueHere = useContinueHere();
  const resume = useResumeAudit();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<readonly string[]>([]);

  const items = elsewhere.data ?? [];
  const signsOut = !movesWithoutSignOut(user?.role);
  const mustSignOut = signsOut && items.some((item) => item.stillSignedIn);

  const show = () => {
    setPicked([]);
    continueHere.reset();
    setOpen(true);
  };

  useEffect(() => {
    if (mustSignOut && !askedThisLaunch) {
      askedThisLaunch = true;
      setPicked([]);
      setOpen(true);
    }
  }, [mustSignOut]);

  if (items.length === 0) return null;

  const several = items.length > 1;
  // One audit needs no choosing. With several, only the ticked ones move.
  const chosen = several ? items.filter((item) => picked.includes(item.audit.id)) : items;
  // The question speaks of the chosen audits once any are ticked, and of them all until then.
  const about = chosen.length > 0 ? chosen : items;
  const signsOutChosen = signsOut && about.some((item) => item.stillSignedIn);

  const where = whereOf(items);
  const count = items.length === 1 ? 'An audit' : `${items.length} audits`;
  const toggle = (id: string, on: boolean) =>
    setPicked((current) => (on ? [...current, id] : current.filter((other) => other !== id)));

  const confirm = () =>
    continueHere.mutate(chosen, {
      onSuccess: () => {
        setOpen(false);
        // One audit goes straight back to the question it stopped on.
        if (chosen.length === 1) {
          const { audit } = chosen[0]!;
          resume.mutate({ id: audit.id, status: audit.status, auditType: audit.auditType });
        }
      },
    });

  const action = signsOutChosen ? 'Sign out and continue here' : 'Continue here';
  const confirmLabel = several && chosen.length > 0 ? `${action} (${chosen.length})` : action;

  return (
    <>
      <SlipStack
        rows={[
          {
            tone: 'slip',
            title: `${count} of yours ${items.length === 1 ? 'is' : 'are'} open on ${where}`,
            detail: mustSignOut ? 'Sign out of it to continue here.' : 'Tap to continue here.',
            onPress: show,
          },
        ]}
      />
      <ChoiceDialog
        visible={open}
        title={signsOutChosen ? `Sign out of ${whereOf(about)}?` : several ? 'Which audits continue here?' : 'Continue here?'}
        message={message(items, about, signsOutChosen)}
        confirmLabel={confirmLabel}
        cancelLabel="Not now"
        busy={continueHere.isPending || resume.isPending}
        confirmDisabled={chosen.length === 0}
        error={continueHere.error ? problemMessage(continueHere.error) : null}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      >
        {several ? (
          // Grouped by Unit like every audit list (owner, 2026-11-27).
          <AuditGroupList
            groups={groupAuditsByUnit(items, ({ audit }) => audit)}
            showUnit
            noun={['audit', 'audits']}
            keyOf={(item) => item.audit.id}
            renderItem={(item) => (
              <CheckRow
                label={rowLabel(item)}
                detail={detail(item, signsOut)}
                checked={picked.includes(item.audit.id)}
                onChange={(on) => toggle(item.audit.id, on)}
              />
            )}
          />
        ) : null}
      </ChoiceDialog>
    </>
  );
}

/** "Pixel 8", or "other devices" when the audits are spread over more than one. */
function whereOf(items: readonly AuditElsewhere[]): string {
  const devices = [...new Set(items.map((item) => deviceLabel(item.device)))];
  return devices.length === 1 ? devices[0]! : 'other devices';
}

/**
 * The words above the buttons. `items` is every audit held elsewhere; `about` is the ones the
 * question is about: the ticked ones, or all of them before any are ticked.
 */
function message(items: readonly AuditElsewhere[], about: readonly AuditElsewhere[], mustSignOut: boolean): string {
  const several = items.length > 1;
  const where = whereOf(about);
  const synced = about
    .map((item) => item.device?.lastSyncAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const lastSync = synced ? ` It last uploaded at ${formatDateTime(synced)}.` : '';

  if (several) {
    const consequence = mustSignOut
      ? `Signing out of ${where} brings the ticked audits here, with every answer and photo uploaded.${lastSync} The rest stay where they are; on a device signed out here, they carry on once you sign back in there.`
      : `The ticked audits come here, with every answer and photo uploaded, and their old device can no longer change them.${lastSync} The rest stay where they are.`;
    return `Tick the audits to continue on this device.\n\n${consequence} Anything not yet uploaded from a ticked audit stays behind, held for review.`;
  }

  const list = items.map(describe).map((line) => `• ${line}`).join('\n');
  const lead = mustSignOut
    ? `You are still signed in on ${where}, where this work is open:`
    : `This work was left open on ${where}:`;
  const consequence = mustSignOut
    ? `Signing out there brings it to this device, with every answer and photo it uploaded.${lastSync} Anything it has not uploaded yet stays behind, held for review.`
    : `Continuing here brings it to this device, with every answer and photo uploaded so far, and ${where} can no longer change it.${lastSync} Anything not yet uploaded from there stays behind, held for review.`;
  return `${lead}\n${list}\n\n${consequence}`;
}

/** "Plant 2, Zone A3 (paused)". */
function describe({ audit }: AuditElsewhere): string {
  const zones = (audit.zoneCodes ?? []).map((code) => {
    const label = zoneLabelFromCode(code);
    return label ? `Zone ${label}` : code;
  });
  const state = audit.status === 'PAUSED' ? 'paused' : 'in progress';
  return `${audit.unitName}${zones.length ? `, ${zones.join(', ')}` : ''} (${state})`;
}

/** A tickable audit under its Unit's heading: "Walk-by, paused". */
function rowLabel({ audit }: AuditElsewhere): string {
  return `${AUDIT_TYPE_LABELS[audit.auditType]}, ${audit.status === 'PAUSED' ? 'paused' : 'in progress'}`;
}

/** The line under a tickable audit: where it is, and whether that device gets signed out. */
function detail({ audit, device, stillSignedIn }: AuditElsewhere, signsOut: boolean): string {
  const zones = zonesLine(audit.zoneCodes ?? []);
  const on = `${zones ? `${zones}, on` : 'On'} ${deviceLabel(device)}`;
  return signsOut && stillSignedIn ? `${on}, still signed in: ticking it signs you out there` : on;
}
