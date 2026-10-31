import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Audit, AuditStatus, AuditType } from '@audit5s/contracts';
import { zonesLine } from '@audit5s/domain';
import { formatDate, formatPct } from '../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, isFinished } from '../lib/labels';
import { useResumableAudits, useResumeAudit } from '../lib/resume-audit';
import { bandOf, createThemedStyles } from '../lib/theme';
import { Card, Chip, Data, Figure, Muted, Slip, SlipText } from './ui';

/**
 * One audit on a management board — the Audits tab's card, and Overview's "Auditing now".
 *
 * One component so the two cannot drift: the owner asked for Overview to read exactly as
 * Audits does. With one Unit in view (a Coordinator, R-42) the card leads with the auditor,
 * because the Unit's name is the same on every row; across Units it leads with the Unit.
 * A finished, scored audit wears its band as the rail and its score as the figure.
 *
 * An audit this phone is running (a Coordinator's or Super Admin's own) opens back into the
 * questionnaire, not the read-only page that says it is running on their phone.
 */
export function AuditCard({ audit, oneUnit }: { audit: Audit; oneUnit: boolean }) {
  const styles = useStyles();
  const router = useRouter();
  const finished = isFinished(audit.status);
  const band = bandOf(audit.totals.scorePercentage);
  const here = useResumableAudits().data?.find((local) => local.id === audit.id);
  const resume = useResumeAudit();
  return (
    <Card
      rail={finished && audit.scored ? band : undefined}
      accessibilityRole="button"
      onPress={() =>
        here
          ? resume.mutate(here)
          : router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: audit.id } })
      }
    >
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title}>{oneUnit ? audit.auditorName : audit.unitName}</Text>
          {audit.zoneCodes?.length ? <Text style={styles.zones}>{zonesLine(audit.zoneCodes)}</Text> : null}
          <Muted>
            {oneUnit ? AUDIT_TYPE_LABELS[audit.auditType] : `${AUDIT_TYPE_LABELS[audit.auditType]} by ${audit.auditorName}`}
          </Muted>
          <Data>
            {finished && audit.completedAt
              ? `Completed ${formatDate(audit.completedAt)}`
              : audit.startedAt
                ? `Started ${formatDate(audit.startedAt)}`
                : 'Not started yet'}
          </Data>
          {here ? <Text style={styles.zones}>On this phone · tap to {here.status === 'PAUSED' ? 'resume' : 'continue'}</Text> : null}
        </View>
        <View style={styles.side}>
          <Chip tone={AUDIT_STATUS_TONE[audit.status]}>{AUDIT_STATUS_LABELS[audit.status]}</Chip>
          {finished && audit.scored ? (
            <Figure band={band} size={22}>
              {formatPct(audit.totals.scorePercentage)}
            </Figure>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/**
 * The way back into the audit this phone is running, on top of a management board (Overview,
 * Audits). Read from SQLite, so it is there before the server has heard of the audit, and
 * with the radio off.
 */
export function ResumeSlip() {
  const open = useResumableAudits().data?.[0];
  const resume = useResumeAudit();
  if (!open) return null;
  const paused = open.status === 'PAUSED';
  return (
    <Slip accessibilityRole="button" title="Your audit on this phone" onPress={() => resume.mutate(open)}>
      <SlipText>
        {AUDIT_TYPE_LABELS[open.auditType as AuditType]}
        {open.unitName ? ` at ${open.unitName}` : ''}, {AUDIT_STATUS_LABELS[open.status as AuditStatus].toLowerCase()}.{' '}
        {paused ? 'Tap to resume' : 'Tap to carry on'} where you stopped.
      </SlipText>
    </Slip>
  );
}

const useStyles = createThemedStyles((theme) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.md },
  text: { flex: 1, gap: 2 },
  side: { alignItems: 'flex-end', gap: theme.space.sm },
  title: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  zones: { fontFamily: theme.family.bold, fontSize: theme.font.base, color: theme.color.ink },
}));
