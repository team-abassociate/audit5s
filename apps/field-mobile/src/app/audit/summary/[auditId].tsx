import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import type { AuditScoreSummary } from '@audit5s/contracts';
import { S_SECTION_SHORT_LABELS, bandFor } from '@audit5s/domain';
import { api } from '../../../lib/api';
import { Card, EmptyState, Heading, Muted, Screen } from '../../../components/ui';
import { theme } from '../../../lib/theme';

/**
 * The Consultant's score summary — `GET /audits/{id}/summary` (§8.6, N6).
 *
 * **This is explicitly not a PDF, and the screen says so out loud.** C4 and N5 settle it:
 * official reporting is a Super Admin deliverable, and a Consultant who could generate one
 * from a phone would be issuing a document the business did not authorise. What a
 * Consultant needs on site is their own numbers, which is what this is — a read model.
 *
 * It reads from the server rather than from SQLite, deliberately: **scoring is
 * server-authoritative** (D5). The device computed the same numbers while the audit was in
 * progress and showed them then; once it is finished, the number that matters is the one
 * the server recomputed, and showing a locally derived figure here would be showing a
 * second opinion on a settled question.
 */
export default function AuditSummaryScreen() {
  const { auditId } = useLocalSearchParams<{ auditId: string }>();

  const summary = useQuery({
    queryKey: ['audit-summary', auditId],
    queryFn: () => api.get<AuditScoreSummary>(`/audits/${auditId}/summary`),
    enabled: Boolean(auditId),
  });

  if (summary.isLoading) {
    return (
      <Screen>
        <Muted>Loading the scores…</Muted>
      </Screen>
    );
  }

  if (summary.error || !summary.data) {
    return (
      <Screen>
        <EmptyState
          title="Scores not available"
          detail={
            'This needs a connection — the finished score is the server’s, not this ' +
            'device’s. Try again when you have signal.'
          }
        />
      </Screen>
    );
  }

  const data = summary.data;

  // §2.7: a walk-by has no questionnaire and no score. Saying so beats printing zeros that
  // look like a very bad audit.
  if (!data.scored) {
    return (
      <Screen>
        <EmptyState
          title="This is a walk-by"
          detail="A walk-by records observations and photographs; it is not scored, and it is excluded from every score metric."
        />
      </Screen>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Heading>Score summary</Heading>
      <Muted>
        Your own figures, as the server computed them. This is not the official report —
        those are issued by a Super Admin.
      </Muted>

      <Card>
        <Text style={styles.cardTitle}>Whole audit</Text>
        <Totals totals={data.audit.totals} />
        <SectionBars sections={data.audit.sections} />
      </Card>

      {data.zones.map((zone) => (
        <Card key={zone.auditZoneId ?? zone.auditId}>
          <Text style={styles.cardTitle}>
            Zone {zone.zoneCode} — {zone.zoneName}
          </Text>
          {zone.checklistTemplateName ? <Muted>{zone.checklistTemplateName}</Muted> : null}
          <Totals totals={zone.totals} />
          <SectionBars sections={zone.sections} />
        </Card>
      ))}

      <Muted>
        NA answers are excluded from the applicable maximum, so a Zone with nothing
        applicable shows N/A rather than 0%.
      </Muted>
    </ScrollView>
  );
}

function Totals({ totals }: { totals: AuditScoreSummary['audit']['totals'] }) {
  const band = bandFor(totals.scorePercentage);
  return (
    <View style={styles.totals}>
      <View>
        <Text style={styles.label}>MARKS</Text>
        <Text style={styles.value}>
          {totals.rawScore} / {totals.maxScore}
        </Text>
      </View>
      <View>
        <Text style={styles.label}>PERCENTAGE</Text>
        <Text style={[styles.value, band ? { color: band.color } : styles.na]}>
          {formatPercentage(totals.scorePercentage)}
        </Text>
      </View>
      <View>
        <Text style={styles.label}>RATING</Text>
        <Text style={[styles.value, band ? { color: band.color } : styles.na]}>
          {band?.label ?? 'N/A'}
        </Text>
      </View>
    </View>
  );
}

/**
 * The five S scores as bars.
 *
 * Bars rather than the report's radar: a pentagon at phone width is decoration, and the
 * question a Consultant asks on site is "which S is weak", which a sorted row of bars
 * answers at a glance. The colours are the shared rating-scale tokens, so this screen and
 * the PDF agree about what 74 % looks like.
 */
function SectionBars({ sections }: { sections: AuditScoreSummary['audit']['sections'] }) {
  return (
    <View style={styles.sections}>
      {sections.map((section) => {
        const band = bandFor(section.pct);
        return (
          <View key={section.section} style={styles.sectionRow}>
            <Text style={styles.sectionLabel}>{S_SECTION_SHORT_LABELS[section.section]}</Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${section.pct ?? 0}%`,
                    backgroundColor: band?.color ?? theme.color.textMuted,
                  },
                ]}
              />
            </View>
            <Text style={styles.sectionValue}>
              {section.raw}/{section.max}
            </Text>
            <Text style={[styles.sectionPct, band ? { color: band.color } : styles.na]}>
              {formatPercentage(section.pct)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** A6: one decimal. `null` is "nothing applicable" (D4), never zero. */
function formatPercentage(pct: number | null): string {
  return pct === null ? 'N/A' : `${pct.toFixed(1)}%`;
}

const styles = StyleSheet.create({
  content: { padding: theme.space.md, gap: theme.space.md },
  cardTitle: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  totals: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: theme.space.sm,
  },
  label: { fontSize: 10, letterSpacing: 0.6, color: theme.color.textMuted },
  value: { fontSize: theme.font.lg, fontWeight: '700', color: theme.color.text },
  na: { color: theme.color.textMuted },
  sections: { marginTop: theme.space.md, gap: 6 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionLabel: { width: 26, fontSize: theme.font.sm, fontWeight: '600', color: theme.color.text },
  track: { flex: 1, height: 10, borderRadius: 5, backgroundColor: '#EFE7E4', overflow: 'hidden' },
  fill: { height: 10, borderRadius: 5 },
  sectionValue: { width: 46, textAlign: 'right', fontSize: theme.font.sm, color: theme.color.textMuted },
  sectionPct: { width: 52, textAlign: 'right', fontSize: theme.font.sm, fontWeight: '600' },
});
