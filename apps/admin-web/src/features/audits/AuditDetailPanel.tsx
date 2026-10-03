import { useEffect, useState } from 'react';
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
import { RESPONSE_TOKENS, zoneDisplayLabel } from '@audit5s/domain';
import { bandLabel, bandTextClass, responseTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
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
import { AUDIT_STATUS_LABEL, AUDIT_TYPE_LABEL, EVIDENCE_KIND_LABEL, SECTION_LABEL, ZONE_STATUS_LABEL } from '@/lib/labels';

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
        title={`${AUDIT_TYPE_LABEL[audit.auditType]} — ${audit.unitName}`}
        description={`${audit.auditorName} · ${AUDIT_STATUS_LABEL[audit.status]}${
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
            tone={bandTextClass(overall?.totals.scorePercentage ?? null)}
          />
          <Metric
            label="Rating"
            value={bandLabel(overall?.totals.scorePercentage ?? null)}
            tone={bandTextClass(overall?.totals.scorePercentage ?? null)}
          />
        </div>
      ) : (
        <p className="p-4 text-sm text-ink-2">Walk-by audits are observations and are not scored.</p>
      )}

      <EvidenceGallery auditId={auditId} zones={audit.zones} />

      {audit.zones.length === 0 && (
        <p className="px-4 pb-4 text-sm text-ink-3">No Zones have been added yet.</p>
      )}

      {audit.zones.map((zone) => {
        const zoneScore = summary.data?.zones.find((candidate) => candidate.auditZoneId === zone.id);
        return (
          <div key={zone.id} className="border-t border-edge-soft">
            <div className="flex items-baseline justify-between px-4 py-3">
              <div>
                {/* The D6 snapshots, never the live Zone: renaming it must not move this. */}
                <h3 className="gb-h2">
                  {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                </h3>
                {zone.zoneDescriptionSnapshot && (
                  <p className="text-xs text-ink-3">{zone.zoneDescriptionSnapshot}</p>
                )}
                <p className="text-xs text-ink-3">
                  {zone.checklistTemplateNameSnapshot ?? 'No checklist'}
                  {zone.zoneLeaderNameSnapshot ? ` · Zone Leader: ${zone.zoneLeaderNameSnapshot}` : ''}
                </p>
              </div>
              <Badge tone={zone.status === 'COMPLETED' ? 'good' : zone.status === 'WITHDRAWN' ? 'neutral' : 'warn'}>
                {ZONE_STATUS_LABEL[zone.status]}
              </Badge>
            </div>

            {audit.scored && <SectionTable sections={zoneScore?.sections ?? zone.sections} />}

            {zone.zoneRemark && (
              <p className="px-4 pb-3 text-sm text-ink-2">
                <span className="font-semibold">Zone remark: </span>
                {zone.zoneRemark}
              </p>
            )}

            {/* R-38: each of these becomes a corrective action when the audit completes. */}
            {(zone.overallActionSuggestions ?? []).length > 0 && (
              <div className="px-4 pb-3 text-sm text-ink-2">
                <span className="font-semibold">Overall corrective action suggestions:</span>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {zone.overallActionSuggestions.map((suggestion, index) => (
                    <li key={index}>{suggestion}</li>
                  ))}
                </ol>
              </div>
            )}

            {zone.responses.length > 0 && (
              <details className="px-4 pb-4">
                <summary className="cursor-pointer text-sm text-ink-2">
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
                        <tr key={response.id} className="border-t border-edge-soft">
                          <Td>{response.globalOrder}</Td>
                          <Td className="text-ink-3">
                            {SECTION_LABEL[response.section]}
                          </Td>
                          <Td>
                            <span className={cn('font-medium', responseTextClass(response.value))}>
                              {token.label}
                            </span>
                          </Td>
                          <Td>{response.numericScore ?? 'NA'}</Td>
                          <Td className="text-ink-2">{response.remark ?? ''}</Td>
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
        <div className="border-t border-edge-soft p-4">
          <Field
            label="Cancel this audit"
            hint="Cancelling keeps everything that was recorded. No one can delete an audit."
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
    <section className="border-t border-edge-soft p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="gb-h2">Evidence gallery</h3>
          <p className="text-xs text-ink-3">Thumbnails load here; originals load only when opened.</p>
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
        <p className="py-4 text-sm text-ink-3">No evidence matches these filters.</p>
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
      {selected && (
        <EvidenceViewer
          evidence={selected}
          caption={evidenceCaption(selected, zones)}
          onClose={() => setSelected(null)}
        />
      )}
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
      className="overflow-hidden border border-edge-soft bg-tile text-left hover:border-edge focus:ring-2 focus:ring-accent focus:outline-none"
      aria-label={`Open ${label} evidence`}
      onClick={onOpen}
    >
      {thumbnail.data ? (
        <img className="aspect-4/3 w-full bg-tile-2 object-cover" src={thumbnail.data.url} alt={`${label} audit evidence`} />
      ) : (
        <div className="aspect-4/3 grid place-items-center bg-tile-2 text-xs text-ink-3">
          {thumbnail.error ? 'Preview unavailable' : 'Loading preview…'}
        </div>
      )}
      <div className="space-y-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <Badge tone={evidenceTone(evidence.classification)}>{label}</Badge>
          {evidence.isSummaryFlagged && <Badge tone="warn">Summary photo</Badge>}
        </div>
        <p className="text-xs text-ink-3">{EVIDENCE_KIND_LABEL[evidence.kind]}</p>
        {evidence.remark && <p className="line-clamp-2 text-sm text-ink-2">{evidence.remark}</p>}
        {!evidence.mediaProcessedAt && <p className="text-xs text-ink-3">Thumbnail processing</p>}
      </div>
    </button>
  );
}

/**
 * Where a photo was taken, from what the detail already holds: the Zone, and the response's
 * Sr. and S. The question's wording is not on the audit detail, so it is not guessed at.
 */
function evidenceCaption(evidence: Evidence, zones: AuditDetail['zones']): string | undefined {
  const zone = zones.find((candidate) => candidate.id === evidence.auditZoneId);
  if (!zone) return undefined;
  const parts = [zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)];
  const response = zone.responses.find((candidate) => candidate.id === evidence.questionResponseId);
  if (response) parts.push(`Sr. ${response.globalOrder} · ${SECTION_LABEL[response.section]}`);
  return parts.join(' · ');
}

/**
 * The full-size original, fetched on demand (PART 16). Shared with the corrective-action queue.
 *
 * A native modal `<dialog>` (the system's `Dialog`): focus moves in on open, Escape and a press
 * on the scrim close it, and the page behind is inert. The caller mounts it only while open,
 * so the dialog leaves the DOM rather than being `close()`d, and the browser's own focus return
 * never runs; the control that opened it is remembered at first render, before the dialog took
 * focus, and handed focus back once the dialog is gone.
 */
export function EvidenceViewer({
  evidence,
  caption,
  onClose,
}: {
  evidence: Pick<Evidence, 'id' | 'remark'>;
  /** Where the photo was taken, when the caller knows. */
  caption?: string;
  onClose: () => void;
}) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // A passive cleanup runs after the dialog has left the DOM, so the page is no longer inert.
  // The focus waits one task: a press on the scrim closes the dialog during `mousedown`, and
  // the browser's own focus step for that press runs afterwards and would land on <body>.
  useEffect(
    () => () => {
      window.setTimeout(() => opener?.focus(), 0);
    },
    [opener],
  );

  const original = useQuery({
    queryKey: ['evidence-view-url', evidence.id, 'original'],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidence.id}/view-url?variant=original`),
    staleTime: 240_000,
  });

  const description =
    caption || evidence.remark ? (
      <>
        {caption}
        {caption && evidence.remark ? <br /> : null}
        {evidence.remark}
      </>
    ) : undefined;

  return (
    <Dialog open onClose={onClose} title="Full-size evidence" description={description} wide>
      <div className="gb-dialog-section">
        {original.isLoading && <Spinner label="Loading original…" />}
        {original.error && <ErrorNotice error={original.error} />}
        {original.data && (
          <img
            className="max-h-[65vh] w-full object-contain"
            src={original.data.url}
            alt={caption ? `Full-size audit evidence, ${caption}` : 'Full-size audit evidence'}
          />
        )}
      </div>
    </Dialog>
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
          return (
            <tr key={section.section} className="border-t border-edge-soft">
              <Td>{SECTION_LABEL[section.section]}</Td>
              <Td>{section.raw}</Td>
              <Td>{section.max}</Td>
              <Td>
                <span className={cn('font-semibold', bandTextClass(section.pct))}>
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
      className="gb-slip space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        override.mutate();
      }}
    >
      <h3 className="gb-h2">Correct a completed audit</h3>
      <p className="text-xs text-ink-2">
        This is the only way to change a completed audit. Each change is saved in the Activity
        log with the old and new answer, and the scores are worked out again.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Response">
          <select
            className="w-full border border-edge px-2 py-1.5 text-sm"
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
            className="w-full border border-edge px-2 py-1.5 text-sm"
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

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label}</p>
      <p className={cn('text-lg font-semibold', tone)}>
        {value}
      </p>
    </div>
  );
}
