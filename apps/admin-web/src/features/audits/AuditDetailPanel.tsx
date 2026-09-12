import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditDetail,
  AuditScoreSummary,
  Evidence,
  EvidenceClassification,
  EvidenceViewUrl,
  Page,
  SectionScorePayload,
} from '@audit5s/contracts';
import { RESPONSE_TOKENS, S_SECTION_LABELS, bandFor, zoneDisplayLabel } from '@audit5s/domain';
import { api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { AUDIT_TYPE_LABELS, STATUS_LABELS } from './AuditsPage';

/**
 * One audit: its S-wise scores, every response, and the two administrative actions PART 6
 * gives a Super Admin — cancel, and the post-completion override.
 *
 * The score comes from `GET /audits/{id}/summary`, which recomputes rather than reading a
 * cache, so this panel and the eventual report cannot disagree. Percentages are rendered
 * with one decimal (A6) and coloured by `bandFor`, the same table the PDF uses (R-6c).
 */
export function AuditDetailPanel({ auditId, onClose }: { auditId: string; onClose: () => void }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [cancelReason, setCancelReason] = useState('');

  const detail = useQuery({
    queryKey: ['audit', auditId],
    queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`),
  });

  const summary = useQuery({
    queryKey: ['audit-summary', auditId],
    queryFn: () => api.get<AuditScoreSummary>(`/audits/${auditId}/summary`),
    enabled: detail.data?.scored === true,
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/audits/${auditId}/cancel`, { reason: cancelReason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
      await queryClient.invalidateQueries({ queryKey: ['audit', auditId] });
    },
  });

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return null;

  const audit = detail.data;
  const overall = summary.data?.audit;
  const cancellable = ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'].includes(audit.status);

  return (
    <Card>
      <CardHeader
        title={`${AUDIT_TYPE_LABELS[audit.auditType]} — ${audit.unitName}`}
        description={`${audit.auditorName} · ${STATUS_LABELS[audit.status]}${
          audit.pauseReason ? ` · paused: ${audit.pauseReason}` : ''
        }`}
        action={<Button variant="secondary" onClick={onClose}>Close</Button>}
      />

      {audit.scored ? (
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <Metric label="Marks" value={`${audit.totals.rawScore} / ${audit.totals.maxScore}`} />
          <Metric
            label="Percentage"
            value={
              overall?.totals.scorePercentage === null || overall === undefined
                ? 'N/A'
                : `${overall.totals.scorePercentage.toFixed(1)}%`
            }
            color={bandFor(overall?.totals.scorePercentage ?? null)?.color}
          />
          <Metric
            label="Rating"
            value={bandFor(overall?.totals.scorePercentage ?? null)?.label ?? 'N/A'}
            color={bandFor(overall?.totals.scorePercentage ?? null)?.color}
          />
        </div>
      ) : (
        <p className="p-4 text-sm text-neutral-600">Walk-by audits are observations and are not scored.</p>
      )}

      <EvidenceGallery auditId={auditId} zones={audit.zones} />

      {audit.zones.length === 0 && (
        <p className="px-4 pb-4 text-sm text-neutral-500">No Zones have been added yet.</p>
      )}

      {audit.zones.map((zone) => {
        const zoneScore = summary.data?.zones.find((candidate) => candidate.auditZoneId === zone.id);
        return (
          <div key={zone.id} className="border-t border-neutral-200">
            <div className="flex items-baseline justify-between px-4 py-3">
              <div>
                {/* The D6 snapshots, never the live Zone: renaming it must not move this. */}
                <h3 className="text-sm font-semibold text-neutral-900">
                  {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                </h3>
                {zone.zoneDescriptionSnapshot && (
                  <p className="text-xs text-neutral-500">{zone.zoneDescriptionSnapshot}</p>
                )}
                <p className="text-xs text-neutral-500">
                  {zone.checklistTemplateNameSnapshot ?? 'No checklist'}
                  {zone.zoneLeaderNameSnapshot ? ` · Zone Leader: ${zone.zoneLeaderNameSnapshot}` : ''}
                </p>
              </div>
              <Badge tone={zone.status === 'COMPLETED' ? 'good' : 'warn'}>{zone.status}</Badge>
            </div>

            {audit.scored && <SectionTable sections={zoneScore?.sections ?? zone.sections} />}

            {zone.zoneRemark && (
              <p className="px-4 pb-3 text-sm text-neutral-700">
                <span className="font-semibold">Zone remark: </span>
                {zone.zoneRemark}
              </p>
            )}

            {zone.responses.length > 0 && (
              <details className="px-4 pb-4">
                <summary className="cursor-pointer text-sm text-neutral-600">
                  {zone.responses.length} response{zone.responses.length === 1 ? '' : 's'}
                </summary>
                <Table>
                  <thead>
                    <tr>
                      <Th>Sr.</Th>
                      <Th>S</Th>
                      <Th>Response</Th>
                      <Th>Marks</Th>
                      <Th>Remark</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {zone.responses.map((response) => {
                      const token = RESPONSE_TOKENS[response.value]!;
                      return (
                        <tr key={response.id} className="border-t border-neutral-200">
                          <Td>{response.globalOrder}</Td>
                          <Td className="text-neutral-500">
                            {S_SECTION_LABELS[response.section]}
                          </Td>
                          <Td>
                            <span style={{ color: token.color }} className="font-medium">
                              {token.label}
                            </span>
                          </Td>
                          <Td>{response.numericScore ?? 'NA'}</Td>
                          <Td className="text-neutral-600">{response.remark ?? ''}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </details>
            )}
          </div>
        );
      })}

      {can('audit', 'cancel') && cancellable && (
        <div className="border-t border-neutral-200 p-4">
          <Field
            label="Cancel this audit"
            hint="Voids it and keeps every row (A-1). There is no delete, for anybody."
          >
            <div className="flex gap-2">
              <Input
                placeholder="Reason (required)"
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={cancelReason.trim().length === 0 || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel audit
              </Button>
            </div>
          </Field>
          {cancel.error && <ErrorNotice error={cancel.error} />}
        </div>
      )}

      {audit.scored && can('audit', 'edit_after_completion') && audit.status === 'COMPLETED' && (
        <OverrideForm auditId={auditId} audit={audit} />
      )}
    </Card>
  );
}

function EvidenceGallery({
  auditId,
  zones,
}: {
  auditId: string;
  zones: AuditDetail['zones'];
}) {
  const [zoneId, setZoneId] = useState('');
  const [classification, setClassification] = useState<'' | EvidenceClassification>('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selected, setSelected] = useState<Evidence | null>(null);

  const gallery = useInfiniteQuery({
    queryKey: ['audit-evidence', auditId, zoneId, classification, flaggedOnly],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '24' });
      if (zoneId) query.set('auditZoneId', zoneId);
      if (classification) query.set('classification', classification);
      if (flaggedOnly) query.set('summaryFlaggedOnly', 'true');
      if (pageParam) query.set('cursor', pageParam);
      return api.get<Page<Evidence>>(`/audits/${auditId}/evidence?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const evidence = gallery.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="border-t border-neutral-200 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">Evidence gallery</h3>
          <p className="text-xs text-neutral-500">Thumbnails load here; originals load only when opened.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Zone">
            <Select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
              <option value="">All Zones</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Classification">
            <Select
              value={classification}
              onChange={(event) =>
                setClassification(event.target.value as '' | EvidenceClassification)
              }
            >
              <option value="">All</option>
              <option value="GOOD">Good</option>
              <option value="NONCONFORMITY">Nonconformity</option>
              <option value="NEUTRAL">Neutral</option>
            </Select>
          </Field>
          <Button variant={flaggedOnly ? 'primary' : 'secondary'} onClick={() => setFlaggedOnly((value) => !value)}>
            Flagged only
          </Button>
        </div>
      </div>

      {gallery.isLoading && <Spinner label="Loading evidence…" />}
      {gallery.error && <ErrorNotice error={gallery.error} />}
      {!gallery.isLoading && evidence.length === 0 && (
        <p className="py-4 text-sm text-neutral-500">No evidence matches these filters.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {evidence.map((item) => (
          <EvidenceTile key={item.id} evidence={item} onOpen={() => setSelected(item)} />
        ))}
      </div>
      {gallery.hasNextPage && (
        <Button className="mt-3" variant="secondary" disabled={gallery.isFetchingNextPage} onClick={() => gallery.fetchNextPage()}>
          {gallery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {selected && <EvidenceViewer evidence={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function EvidenceTile({ evidence, onOpen }: { evidence: Evidence; onOpen: () => void }) {
  const thumbnail = useQuery({
    queryKey: ['evidence-view-url', evidence.id, 'thumbnail'],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidence.id}/view-url?variant=thumbnail`),
    staleTime: 240_000,
  });
  const label = evidence.classification === 'NONCONFORMITY' ? 'Nonconformity' : evidence.classification === 'GOOD' ? 'Good' : 'Neutral';

  return (
    <button
      type="button"
      className="overflow-hidden rounded-lg border border-neutral-200 bg-white text-left hover:border-brand focus:ring-2 focus:ring-brand focus:outline-none"
      aria-label={`Open ${label} evidence`}
      onClick={onOpen}
    >
      {thumbnail.data ? (
        <img className="aspect-4/3 w-full bg-neutral-100 object-cover" src={thumbnail.data.url} alt={`${label} audit evidence`} />
      ) : (
        <div className="aspect-4/3 grid place-items-center bg-neutral-100 text-xs text-neutral-500">
          {thumbnail.error ? 'Preview unavailable' : 'Loading preview…'}
        </div>
      )}
      <div className="space-y-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge tone={evidenceTone(evidence.classification)}>{label}</Badge>
          {evidence.isSummaryFlagged && <Badge tone="warn">Summary photo</Badge>}
        </div>
        <p className="text-xs text-neutral-500">{evidence.kind.replaceAll('_', ' ').toLowerCase()}</p>
        {evidence.remark && <p className="line-clamp-2 text-sm text-neutral-700">{evidence.remark}</p>}
        {!evidence.mediaProcessedAt && <p className="text-xs text-neutral-400">Thumbnail processing</p>}
      </div>
    </button>
  );
}

/** The full-size original, fetched on demand (PART 16). Shared with the corrective-action queue. */
export function EvidenceViewer({
  evidence,
  onClose,
}: {
  evidence: Pick<Evidence, 'id' | 'remark'>;
  onClose: () => void;
}) {
  const original = useQuery({
    queryKey: ['evidence-view-url', evidence.id, 'original'],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidence.id}/view-url?variant=original`),
    staleTime: 240_000,
  });

  return (
    <div role="dialog" aria-modal="true" aria-label="Full-size evidence" className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4">
      <div className="max-h-full w-full max-w-5xl overflow-auto rounded-lg bg-white p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-neutral-900">Full-size evidence</h3>
            {evidence.remark && <p className="text-sm text-neutral-600">{evidence.remark}</p>}
          </div>
          <Button variant="secondary" onClick={onClose}>Close viewer</Button>
        </div>
        {original.isLoading && <Spinner label="Loading original…" />}
        {original.error && <ErrorNotice error={original.error} />}
        {original.data && <img className="max-h-[75vh] w-full object-contain" src={original.data.url} alt="Full-size audit evidence" />}
      </div>
    </div>
  );
}

function evidenceTone(classification: EvidenceClassification): 'neutral' | 'good' | 'bad' {
  return classification === 'GOOD' ? 'good' : classification === 'NONCONFORMITY' ? 'bad' : 'neutral';
}

/** The S-wise table of §4.1. A fully-NA section prints `N/A` (D4). */
function SectionTable({ sections }: { sections: SectionScorePayload[] }) {
  if (sections.length === 0) return null;
  return (
    <Table>
      <thead>
        <tr>
          <Th>S</Th>
          <Th>Achieved</Th>
          <Th>Max</Th>
          <Th>Percentage</Th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section) => {
          const band = bandFor(section.pct);
          return (
            <tr key={section.section} className="border-t border-neutral-200">
              <Td>{S_SECTION_LABELS[section.section]}</Td>
              <Td>{section.raw}</Td>
              <Td>{section.max}</Td>
              <Td>
                <span style={band ? { color: band.color } : undefined} className="font-semibold">
                  {section.pct === null ? 'N/A' : `${section.pct.toFixed(1)}%`}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/**
 * A-2's only door.
 *
 * The justification is required by the contract, not by politeness: the whole point of the
 * endpoint is the `AuditLog` entry it writes, and an override with no stated reason is the
 * case the invariant exists to prevent.
 */
function OverrideForm({ auditId, audit }: { auditId: string; audit: AuditDetail }) {
  const queryClient = useQueryClient();
  const [responseId, setResponseId] = useState('');
  const [value, setValue] = useState('SCORE_2');
  const [justification, setJustification] = useState('');

  const override = useMutation({
    mutationFn: () =>
      api.patch(`/audits/${auditId}/post-completion`, {
        justification,
        changes: { responses: [{ responseId, value }] },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audit', auditId] });
      await queryClient.invalidateQueries({ queryKey: ['audit-summary', auditId] });
      setJustification('');
    },
  });

  const responses = audit.zones.flatMap((zone) =>
    zone.responses.map((response) => ({ zone: zone.zoneCodeSnapshot, response })),
  );

  return (
    <form
      className="space-y-3 border-t border-neutral-200 bg-amber-50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        override.mutate();
      }}
    >
      <h3 className="text-sm font-semibold text-neutral-900">Correct a completed audit</h3>
      <p className="text-xs text-neutral-600">
        This is the only way a completed audit changes (A-2). Every change is written to the
        audit log with its before and after, and the scores are recomputed.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Response">
          <select
            className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={responseId}
            onChange={(event) => setResponseId(event.target.value)}
            required
          >
            <option value="">Choose a response…</option>
            {responses.map(({ zone, response }) => (
              <option key={response.id} value={response.id}>
                {zone} · Q{response.globalOrder} — currently {RESPONSE_TOKENS[response.value]!.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Corrected to">
          <select
            className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            {Object.entries(RESPONSE_TOKENS).map(([token, meta]) => (
              <option key={token} value={token}>
                {meta.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Justification" hint="At least ten characters; it is stored with the change">
        <Input
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
          required
        />
      </Field>

      {override.error && <ErrorNotice error={override.error} />}

      <Button
        type="submit"
        disabled={override.isPending || !responseId || justification.trim().length < 10}
      >
        {override.isPending ? 'Applying…' : 'Apply override'}
      </Button>
    </form>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="text-lg font-semibold" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}
