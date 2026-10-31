import { Image, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import type { AuditScoreSummary, EvidenceViewUrl } from '@audit5s/contracts';
import { bandFor, zoneDisplayLabel } from '@audit5s/domain';
import { api, problemMessage } from '../../../lib/api';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LedgerRow,
  Muted,
  Screen,
  SectionHead,
  SectionRows,
  StatGrid,
  StatusBand,
} from '../../../components/ui';
import { formatPct } from '../../../lib/format';
import { bandOf, createThemedStyles } from '../../../lib/theme';

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
 *
 * The layout is the admin board's detail panel: figures, a band, then the five S rows —
 * bars rather than the report's radar, because the question on site is "which S is weak".
 */
export default function AuditSummaryScreen() {
  const styles = useStyles();
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
        <View style={styles.stack}>
          {/*
            The server's own sentence when it answered, the connection sentence only when
            nothing answered. It used to say "try again when you have signal" whatever had
            happened — so a `404` from a full-strength phone read as a coverage problem,
            and the defect behind 0027 was hunted in the wrong place for a day.
          */}
          <EmptyState
            title="Scores not available"
            detail={
              problemMessage(summary.error) ??
              'The finished score is the server’s, not this device’s. Try again when you have signal.'
            }
          />
          <Button icon="refresh"
            title="Try again"
            variant="secondary"
            busy={summary.isFetching}
            onPress={() => void summary.refetch()}
          />
        </View>
      </Screen>
    );
  }

  const data = summary.data;

  // §2.7: a walk-by has no questionnaire and no score. Saying so beats printing zeros that
  // look like a very bad audit.
  if (!data.scored) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <EmptyState
            title="This is a walk-by"
            detail="A walk-by records observations and photographs; it is not scored, and it is excluded from every score metric."
          />
          {/* R-72: who faced it, all the same. */}
          {data.zones.map((zone) =>
            zone.auditeeName || zone.auditeePhotoEvidenceId ? (
              <Card key={zone.auditZoneId ?? zone.auditId}>
                <CardHeader title={zoneDisplayLabel(zone.zoneCode, zone.zoneName)} />
                <ZoneAuditee name={zone.auditeeName ?? null} photoEvidenceId={zone.auditeePhotoEvidenceId ?? null} />
              </Card>
            ) : null,
          )}
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHead
          title="Score summary"
          description="Your own figures, as the server computed them. This is not the official report; a Super Admin issues those."
        />

        <ScoreBlock title="Whole audit" totals={data.audit.totals} sections={data.audit.sections} />

        {data.zones.map((zone) => (
          <ScoreBlock
            key={zone.auditZoneId ?? zone.auditId}
            title={zoneDisplayLabel(zone.zoneCode, zone.zoneName)}
            description={zone.checklistTemplateName}
            totals={zone.totals}
            sections={zone.sections}
            auditeeName={zone.auditeeName ?? null}
            auditeePhotoEvidenceId={zone.auditeePhotoEvidenceId ?? null}
          />
        ))}

        <Muted>
          NA answers are excluded from the applicable maximum, so a Zone with nothing
          applicable shows N/A rather than 0%.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

function ScoreBlock({
  title,
  description,
  totals,
  sections,
  auditeeName,
  auditeePhotoEvidenceId,
}: {
  title: string;
  description?: string | null;
  totals: AuditScoreSummary['audit']['totals'];
  sections: AuditScoreSummary['audit']['sections'];
  /** R-72, on a Zone's block only. */
  auditeeName?: string | null;
  auditeePhotoEvidenceId?: string | null;
}) {
  const styles = useStyles();
  const band = bandOf(totals.scorePercentage);
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={band === 'none' ? null : <Chip tone={band}>{bandFor(totals.scorePercentage)?.label}</Chip>}
      />
      <StatGrid
        items={[
          { label: 'Marks', value: `${totals.rawScore}/${totals.maxScore}` },
          { label: 'Score', value: formatPct(totals.scorePercentage), band },
        ]}
      />
      <View style={styles.band}>
        <StatusBand band={band} />
      </View>
      <SectionRows
        marks
        rows={sections.map((section) => ({
          section: section.section,
          pct: section.pct,
          raw: section.raw,
          max: section.max,
        }))}
      />
      <ZoneAuditee name={auditeeName ?? null} photoEvidenceId={auditeePhotoEvidenceId ?? null} />
    </Card>
  );
}

/** R-72: who faced the audit of a Zone, and their photo. Nothing for a Zone without either. */
function ZoneAuditee({ name, photoEvidenceId }: { name: string | null; photoEvidenceId: string | null }) {
  const styles = useStyles();
  return (
    <>
      {name ? (
        <View style={styles.auditee}>
          <LedgerRow label="Auditee" value={name} last />
        </View>
      ) : null}
      {photoEvidenceId ? <AuditeePhoto evidenceId={photoEvidenceId} label={name ?? 'Auditee'} /> : null}
    </>
  );
}

/** R-72: the auditee's photo, from the server through a short-lived link. */
function AuditeePhoto({ evidenceId, label }: { evidenceId: string; label: string }) {
  const styles = useStyles();
  const view = useQuery({
    queryKey: ['evidence-view-url', evidenceId],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidenceId}/view-url?variant=thumbnail`),
    staleTime: 240_000,
    retry: false,
  });
  if (!view.data) return view.isError ? <Muted>The auditee photo could not load.</Muted> : null;
  return <Image source={{ uri: view.data.url }} style={styles.auditeePhoto} resizeMode="cover" accessibilityLabel={label} />;
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl, gap: theme.space.sm },
  stack: { gap: theme.space.md },
  band: { marginTop: 10, marginBottom: theme.space.md },
  auditee: { marginTop: theme.space.md },
  auditeePhoto: {
    width: 120,
    aspectRatio: 1,
    marginTop: theme.space.sm,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
}));
