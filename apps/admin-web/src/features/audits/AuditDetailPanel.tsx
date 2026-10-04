import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Audit,
  AuditDetail,
  AuditScoreSummary,
  ChecklistVersionDetail,
  Evidence,
  EvidenceClassification,
  EvidenceViewUrl,
  Page,
  QuestionResponse,
  SectionScorePayload,
} from '@audit5s/contracts';
import { RESPONSE_TOKENS, formatDateTime, zoneDisplayLabel, formatScore } from '@audit5s/domain';
import { bandTextClass, responseTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import {
  Badge,
  BandLabel,
  Button,
  Dialog,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { EVIDENCE_KIND_LABEL, SECTION_LABEL } from '@/lib/labels';
import { TeamProgress } from './AuditProgress';
import { read } from './data';

/** Question id → its English wording, from the checklist versions the audit's Zones used. */
type Questions = Map<string, string>;

/**
 * One audit, as the body of the audits page's side panel (AU1): the team's progress when it
 * was audited together, its S-wise scores, each Zone with every answer beside its question
 * (AU2), the photos captioned with where they were taken (AU5), and the two administrative
 * actions PART 6 gives a Super Admin — cancel, and the post-completion override.
 *
 * The score comes from `GET /audits/{id}/summary`, which recomputes rather than reading a
 * cache, so this panel and the eventual report cannot disagree. Percentages are rendered
 * with one decimal (A6) and coloured by `bandFor`, the same table the PDF uses (R-6c).
 *
 * The question wording is not on the audit: each Zone names its binding checklist version
 * (QR-2), and `GET /checklist-versions/{id}` — readable by every role — holds the questions.
 * A version is immutable once published, so it is fetched once and kept.
 */
export function AuditDetailPanel({
  auditId,
  team,
}: {
  auditId: string;
  /** Set when this audit is one auditor's share of a Unit audit done together. */
  team?: { unitId: string; audits: Audit[]; pending: string[] };
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [cancelReason, setCancelReason] = useState('');

  const detail = useQuery({
    queryKey: ['audit', auditId],
    queryFn: () => read<AuditDetail>(`/audits/${auditId}`),
  });

  const summary = useQuery({
    queryKey: ['audit-summary', auditId],
    queryFn: () => read<AuditScoreSummary>(`/audits/${auditId}/summary`),
    enabled: detail.data?.scored === true,
  });

  const versionIds = [
    ...new Set((detail.data?.zones ?? []).flatMap((zone) => (zone.checklistVersionId ? [zone.checklistVersionId] : []))),
  ];
  const versions = useQueries({
    queries: versionIds.map((id) => ({
      queryKey: ['checklist-version', id],
      queryFn: () => read<ChecklistVersionDetail>(`/checklist-versions/${id}`),
      staleTime: Infinity,
    })),
  });
  const questions: Questions = new Map(
    versions.flatMap((version) => version.data?.questions.map((question) => [question.id, question.text] as const) ?? []),
  );
  const questionsPending = versions.some((version) => version.isLoading);

  const cancel = useMutation({
    mutationFn: () => api.post(`/audits/${auditId}/cancel`, { reason: cancelReason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
      await queryClient.invalidateQueries({ queryKey: ['audit', auditId] });
    },
  });

  if (detail.isLoading) return <Spinner label="Loading the audit…" />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return null;

  const audit = detail.data;
  const overall = summary.data?.audit;
  const cancellable = ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'].includes(audit.status);
  // One source for all three figures: the recomputed summary once it is in, else the audit's own.
  const totals = overall?.totals ?? audit.totals;
  const percentage = totals.scorePercentage;

  return (
    // The panel is narrower than the flush table's 640px minimum, and these tables fit without it.
    <div className="space-y-5 [&_table]:min-w-0!">
      <p className="text-xs text-ink-2">
        {audit.startedAt ? `Started ${formatDateTime(audit.startedAt)}` : 'Not started on the phone yet'}
        {audit.completedAt ? ` · completed ${formatDateTime(audit.completedAt)}` : ''}
        {audit.pauseReason ? ` · paused: ${audit.pauseReason}` : ''}
      </p>

      {team ? (
        <section className="space-y-2">
          <h3 className="gb-label">Team</h3>
          <TeamProgress unitId={team.unitId} audits={team.audits} pending={team.pending} />
        </section>
      ) : null}

      {!audit.scored ? (
        <p className="text-sm text-ink-2">Walk-by audits are observations and are not scored.</p>
      ) : audit.status === 'CANCELLED' ? (
        <p className="text-sm text-ink-2">Cancelled audits have no score. What was recorded is kept below.</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Metric label="Marks" value={`${totals.rawScore} / ${totals.maxScore}`} />
          <Metric
            label="Percentage"
            value={percentage === null ? 'N/A' : `${formatScore(percentage)}%`}
            tone={bandTextClass(percentage)}
          />
          <div>
            <p className="gb-label">Rating</p>
            <p className="mt-1 text-sm font-semibold">
              {overall ? <BandLabel score={percentage} /> : '…'}
            </p>
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="gb-label">
          {audit.zones.length} Zone{audit.zones.length === 1 ? '' : 's'}
        </h3>
        {audit.zones.length === 0 && <p className="text-sm text-ink-3">No Zones have been added yet.</p>}
        {audit.zones.map((zone) => {
          const zoneScore = summary.data?.zones.find((candidate) => candidate.auditZoneId === zone.id);
          const pct = zone.totals.scorePercentage;
          return (
            <details key={zone.id} className="border border-edge-soft">
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                {/* The D6 snapshots, never the live Zone: renaming it must not move this. */}
                <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                  {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                </span>
                <StatusChip kind="zone" status={zone.status} />
                {audit.scored && audit.status !== 'CANCELLED' && zone.status === 'COMPLETED' ? (
                  <span className={cn('gb-data w-14 text-right font-semibold', bandTextClass(pct))}>
                    {pct === null ? 'N/A' : `${formatScore(pct)}%`}
                  </span>
                ) : null}
              </summary>
              <div className="space-y-3 border-t border-edge-soft px-3 py-3">
                <p className="text-xs text-ink-3">
                  {zone.zoneDescriptionSnapshot ? `${zone.zoneDescriptionSnapshot} · ` : ''}
                  {zone.checklistTemplateNameSnapshot ?? 'No checklist'}
                  {zone.zoneLeaderNameSnapshot ? ` · Zone Leader: ${zone.zoneLeaderNameSnapshot}` : ''}
                </p>

                {audit.scored && <SectionTable sections={zoneScore?.sections ?? zone.sections} />}

                {zone.zoneRemark && (
                  <p className="text-sm text-ink-2">
                    <span className="font-semibold">Zone remark: </span>
                    {zone.zoneRemark}
                  </p>
                )}

                {/* R-38: each of these becomes a corrective action when the audit completes. */}
                {(zone.overallActionSuggestions ?? []).length > 0 && (
                  <div className="text-sm text-ink-2">
                    <span className="font-semibold">Overall corrective action suggestions:</span>
                    <ol className="mt-1 list-decimal space-y-1 pl-5">
                      {zone.overallActionSuggestions.map((suggestion, index) => (
                        <li key={index}>{suggestion}</li>
                      ))}
                    </ol>
                  </div>
                )}

                {zone.responses.length > 0 && (
                  <Answers responses={zone.responses} questions={questions} pending={questionsPending} />
                )}
              </div>
            </details>
          );
        })}
      </section>

      <EvidenceGallery auditId={auditId} zones={audit.zones} questions={questions} />

      {can('audit', 'cancel') && cancellable && (
        <div className="border-t border-edge-soft pt-4">
          <Field
            label="Reason to cancel this audit"
            hint="Required. Cancelling keeps everything that was recorded. No one can delete an audit."
          >
            <div className="flex gap-2">
              <Input
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
    </div>
  );
}

/**
 * Every answer of one Zone beside its question (AU2), grouped under its S, so "why did this
 * Zone score 7.3?" is read here rather than in the PDF. `NA` reads "N/A" and has no marks.
 */
function Answers({
  responses,
  questions,
  pending,
}: {
  responses: QuestionResponse[];
  questions: Questions;
  pending: boolean;
}) {
  const rows = [...responses].sort((a, b) => a.globalOrder - b.globalOrder);
  return (
    <details>
      <summary className="cursor-pointer text-sm text-ink-2">
        {responses.length} answer{responses.length === 1 ? '' : 's'}
      </summary>
      <Table>
        <thead>
          <tr>
            <Th width="3.5rem">Sr.</Th>
            <Th>Question</Th>
            <Th width="8rem">Answer</Th>
            <Th width="4rem">Marks</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((response, index) => {
            const token = RESPONSE_TOKENS[response.value]!;
            const newSection = index === 0 || rows[index - 1]!.section !== response.section;
            return [
              newSection ? (
                <tr key={`${response.section}-head`} className="gb-group">
                  <Td colSpan={4}>
                    <span className="gb-group-title">{SECTION_LABEL[response.section]}</span>
                  </Td>
                </tr>
              ) : null,
              <tr key={response.id}>
                <Td className="gb-data">{response.globalOrder}</Td>
                <Td>
                  <span className="[overflow-wrap:anywhere]">
                    {questions.get(response.checklistQuestionId) ??
                      (pending ? 'Loading question…' : 'Question wording unavailable')}
                  </span>
                  {response.remark ? (
                    <span className="mt-1 block text-xs text-ink-2">Remark: {response.remark}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className={cn('font-medium', responseTextClass(response.value))}>
                    {response.value === 'NA' ? 'N/A' : token.label}
                  </span>
                </Td>
                <Td className="gb-data">{response.numericScore ?? 'N/A'}</Td>
              </tr>,
            ];
          })}
        </tbody>
      </Table>
    </details>
  );
}

function EvidenceGallery({
  auditId,
  zones,
  questions,
}: {
  auditId: string;
  zones: AuditDetail['zones'];
  questions: Questions;
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
      return read<Page<Evidence>>(`/audits/${auditId}/evidence?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  // AU5: the auditor's own photo is not a finding, so it sits after the findings' photos.
  const evidence = (gallery.data?.pages.flatMap((page) => page.data) ?? []).sort(
    (a, b) => Number(a.kind === 'AUDITOR_SELFIE') - Number(b.kind === 'AUDITOR_SELFIE'),
  );

  return (
    <section className="space-y-3 border-t border-edge-soft pt-4">
      <div>
        <h3 className="gb-label">Photos</h3>
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
            onChange={(event) => setClassification(event.target.value as '' | EvidenceClassification)}
          >
            <option value="">All</option>
            <option value="GOOD">Good</option>
            <option value="NONCONFORMITY">Nonconformity</option>
            <option value="NEUTRAL">Neutral</option>
          </Select>
        </Field>
        <Button
          variant={flaggedOnly ? 'primary' : 'secondary'}
          aria-pressed={flaggedOnly}
          onClick={() => setFlaggedOnly((value) => !value)}
        >
          Flagged only
        </Button>
      </div>

      {gallery.isLoading && <Spinner label="Loading photos…" />}
      {gallery.error && <ErrorNotice error={gallery.error} />}
      {!gallery.isLoading && evidence.length === 0 && (
        <p className="py-2 text-sm text-ink-3">No photos match these filters.</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {evidence.map((item) => (
          <EvidenceTile
            key={item.id}
            evidence={item}
            caption={evidenceCaption(item, zones, questions)}
            onOpen={() => setSelected(item)}
          />
        ))}
      </div>
      {gallery.hasNextPage && (
        <Button variant="secondary" disabled={gallery.isFetchingNextPage} onClick={() => gallery.fetchNextPage()}>
          {gallery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {selected && (
        <EvidenceViewer
          evidence={selected}
          caption={evidenceCaption(selected, zones, questions)}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function EvidenceTile({
  evidence,
  caption,
  onOpen,
}: {
  evidence: Evidence;
  caption: string | undefined;
  onOpen: () => void;
}) {
  const thumbnail = useQuery({
    queryKey: ['evidence-view-url', evidence.id, 'thumbnail'],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidence.id}/view-url?variant=thumbnail`),
    staleTime: 240_000,
  });
  const label = evidence.classification === 'NONCONFORMITY' ? 'Nonconformity' : evidence.classification === 'GOOD' ? 'Good' : 'Neutral';
  const where = evidence.kind === 'AUDITOR_SELFIE' ? EVIDENCE_KIND_LABEL.AUDITOR_SELFIE : (caption ?? EVIDENCE_KIND_LABEL[evidence.kind]);

  return (
    <button
      type="button"
      className="min-w-0 overflow-hidden border border-edge-soft bg-tile text-left hover:border-edge focus:ring-2 focus:ring-accent focus:outline-none"
      aria-label={`Open photo: ${where}, ${label}`}
      onClick={onOpen}
    >
      {thumbnail.data ? (
        <img className="aspect-4/3 w-full bg-tile-2 object-cover" src={thumbnail.data.url} alt="" />
      ) : (
        <div className="aspect-4/3 grid place-items-center bg-tile-2 text-xs text-ink-3">
          {thumbnail.error ? 'Preview unavailable' : 'Loading preview…'}
        </div>
      )}
      <div className="space-y-1 p-2">
        <div className="flex flex-wrap items-center gap-1">
          {evidence.kind !== 'AUDITOR_SELFIE' && <Badge tone={evidenceTone(evidence.classification)}>{label}</Badge>}
          {evidence.isSummaryFlagged && <Badge tone="warn">Summary photo</Badge>}
        </div>
        <p className="line-clamp-3 text-xs text-ink-2 [overflow-wrap:anywhere]">{where}</p>
        {evidence.remark && <p className="line-clamp-2 text-xs text-ink-3">{evidence.remark}</p>}
        {!evidence.mediaProcessedAt && <p className="text-xs text-ink-3">Thumbnail processing</p>}
      </div>
    </button>
  );
}

/**
 * Where a photo was taken (AU5): the Zone, then the answer's Sr. and S, then its question
 * when the checklist has loaded — "Zone 16 · Sr. 3 · S1 Sort (Seiri) · Are unwanted items…".
 */
function evidenceCaption(evidence: Evidence, zones: AuditDetail['zones'], questions: Questions): string | undefined {
  const zone = zones.find((candidate) => candidate.id === evidence.auditZoneId);
  if (!zone) return undefined;
  const parts = [zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)];
  const response = zone.responses.find((candidate) => candidate.id === evidence.questionResponseId);
  if (response) {
    parts.push(`Sr. ${response.globalOrder}`, SECTION_LABEL[response.section]);
    const question = questions.get(response.checklistQuestionId);
    if (question) parts.push(question);
  }
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

/** The S-wise table of §4.1. A fully-NA section prints `N/A` on the hatch (D4), never 0. */
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
              <Td className={section.pct === null ? 'gb-na' : undefined}>
                <span className={cn('font-semibold', bandTextClass(section.pct))}>
                  {section.pct === null ? 'N/A' : `${formatScore(section.pct)}%`}
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
          <Select
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
          </Select>
        </Field>

        <Field label="Corrected to">
          <Select
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            {Object.entries(RESPONSE_TOKENS).map(([token, meta]) => (
              <option key={token} value={token}>
                {meta.label}
              </option>
            ))}
          </Select>
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
      <p className="gb-label">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold tabular-nums', tone)}>
        {value}
      </p>
    </div>
  );
}
