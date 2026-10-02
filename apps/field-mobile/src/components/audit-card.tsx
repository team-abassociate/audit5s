import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Audit } from '@audit5s/contracts';
import { formatDate, formatPct } from '../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, isFinished } from '../lib/labels';
import { bandOf, createThemedStyles } from '../lib/theme';
import { Card, Chip, Data, Figure, Muted } from './ui';

/**
 * One audit on a management board — the Audits tab's card, and Overview's "Auditing now".
 *
 * One component so the two cannot drift: the owner asked for Overview to read exactly as
 * Audits does. With one Unit in view (a Coordinator, R-42) the card leads with the auditor,
 * because the Unit's name is the same on every row; across Units it leads with the Unit.
 * A finished, scored audit wears its band as the rail and its score as the figure.
 */
export function AuditCard({ audit, oneUnit }: { audit: Audit; oneUnit: boolean }) {
  const styles = useStyles();
  const router = useRouter();
  const finished = isFinished(audit.status);
  const band = bandOf(audit.totals.scorePercentage);
  return (
    <Card
      rail={finished && audit.scored ? band : undefined}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: audit.id } })}
    >
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title}>{oneUnit ? audit.auditorName : audit.unitName}</Text>
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
}));
