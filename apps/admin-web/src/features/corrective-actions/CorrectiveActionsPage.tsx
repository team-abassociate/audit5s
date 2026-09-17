import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CORRECTIVE_ACTION_STATUSES,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionStatus,
  type CorrectiveActionSubmission,
  type EvidenceViewUrl,
  type Audit,
  type Page,
  type Unit,
  type User,
} from '@audit5s/contracts';
import { awaitsReview, isOverdue, sectionLabel } from '@audit5s/domain';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, CardHeader, ErrorNotice, Field, Input, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { EvidenceViewer } from '@/features/audits/AuditDetailPanel';

/**
 * Corrective actions (PART 14, Phase 6's Web row): the Super Admin's queue with verify,
 * reopen and the whole submission history, and — the same page, read-only — the
 * Coordinator's view of their Unit.
 *
 * What a role may do is the server's answer (`/auth/me`), not this page's: the buttons
 * render from `can()`, and the API refuses anything else regardless.
 */
export function CorrectiveActionsPage() {
  const [status, setStatus] = useState<CorrectiveActionStatus | ''>('');
  const [overdue, setOverdue] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [auditId, setAuditId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  /**
   * The chosen Unit's completed audits, for the second filter. Numbered oldest-first so
   * "Audit 3" means the same thing here as on the Analytics tab; a Unit's third audit does
   * not become its fourth because a newer one arrived.
   */
  const audits = useQuery({
    queryKey: ['corrective-actions', 'audits', unitId],
    queryFn: () => api.get<Page<Audit>>(`/audits?unitId=${unitId}&limit=200`),
    enabled: unitId !== '',
  });
  const numbered = useMemo(() => {
    const completed = (audits.data?.data ?? [])
      .filter((audit) => audit.completedAt !== null)
      .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
    return new Map(completed.map((audit, index) => [audit.id, { audit, number: index + 1 }]));
  }, [audits.data]);

  const actions = useQuery({
    queryKey: ['corrective-actions', status, overdue, unitId, auditId],
    queryFn: () =>
      api.get<Page<CorrectiveAction>>(
        `/corrective-actions?limit=200${status ? `&status=${status}` : ''}` +
          `${overdue ? '&overdue=true' : ''}${unitId ? `&unitId=${unitId}` : ''}` +
          `${auditId ? `&auditId=${auditId}` : ''}`,
      ),
    refetchInterval: 60_000,
  });

  const rows = actions.data?.data ?? [];
  const waiting = rows.filter((action) => awaitsReview(action.status)).length;

  /**
   * Unit → audit → its actions.
   *
   * A flat list of every nonconformity in the organization is unusable at more than one
   * Unit: the rows interleave, and nothing tells you which visit produced which finding.
   * Grouping is what makes the page a work queue rather than a log.
   */
  const unitName = (id: string) =>
    units.data?.data.find((unit) => unit.id === id)?.name ?? 'Unknown unit';

  const grouped = useMemo(() => {
    const byUnit = new Map<string, Map<string, CorrectiveAction[]>>();
    for (const action of rows) {
      const byAudit = byUnit.get(action.unitId) ?? new Map<string, CorrectiveAction[]>();
      byAudit.set(action.auditId, [...(byAudit.get(action.auditId) ?? []), action]);
      byUnit.set(action.unitId, byAudit);
    }
    // Worst first at both levels: the Unit carrying the most overdue work comes first, and
    // within it the audit that raised the most. The page opens on what needs attention.
    const overdueCount = (list: CorrectiveAction[]) =>
      list.filter((action) => isOverdue(action.status, action.dueAt, Date.now())).length;
    return [...byUnit.entries()]
      .map(([id, byAudit]) => ({
        unitId: id,
        name: unitName(id),
        audits: [...byAudit.entries()]
          .map(([aid, list]) => ({ auditId: aid, list, overdue: overdueCount(list) }))
          .sort(
            (a, b) =>
              b.overdue - a.overdue ||
              (b.list[0]!.auditCompletedAt ?? '').localeCompare(a.list[0]!.auditCompletedAt ?? ''),
          ),
        overdue: overdueCount([...byAudit.values()].flat()),
        total: [...byAudit.values()].flat().length,
      }))
      .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name));
  }, [rows, units.data]);

  const overdueTotal = grouped.reduce((sum, unit) => sum + unit.overdue, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Corrective actions"
          description={
            'One action per nonconformity photograph. Each is answered, and reviewed, on its ' +
            'own: nothing here acts on more than one at a time, and every attempt is kept.'
          }
          action={waiting > 0 ? <Badge tone="warn">{waiting} awaiting review</Badge> : undefined}
        />
        <div className="flex flex-wrap items-end gap-3 border-b border-edge-soft px-4 py-3">
          <div className="w-56">
            <Field label="Unit">
              <Select
                value={unitId}
                onChange={(event) => {
                  setUnitId(event.target.value);
                  // An audit belongs to one Unit, so a Unit change can only invalidate it.
                  setAuditId('');
                }}
              >
                <option value="">Every unit</option>
                {(units.data?.data ?? []).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-64">
            <Field
              label="Audit"
              hint={unitId === '' ? 'Pick a unit first' : undefined}
            >
              <Select
                value={auditId}
                onChange={(event) => setAuditId(event.target.value)}
                disabled={unitId === '' || numbered.size === 0}
              >
                <option value="">
                  {unitId === ''
                    ? 'Every audit'
                    : numbered.size === 0
                      ? 'No completed audits'
                      : `Every audit · ${numbered.size}`}
                </option>
                {[...numbered.values()]
                  .reverse()
                  .map(({ audit, number }) => (
                    <option key={audit.id} value={audit.id}>
                      {`Audit ${number} · ${new Date(audit.completedAt!).toLocaleDateString()} · ${audit.auditorName}`}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="w-48">
            <Field label="Status">
              <Select value={status} onChange={(event) => setStatus(event.target.value as CorrectiveActionStatus | '')}>
                <option value="">Any</option>
                {CORRECTIVE_ACTION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-2">
            <input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} />
            Overdue only
          </label>
        </div>

        {/*
          The one thing on this page somebody must act on today. It names the Units rather
          than only counting, because "9 overdue" tells a Super Admin nothing about who to
          call — and calling someone is the entire response to an overdue action.
        */}
        {overdueTotal > 0 && !overdue && (
          <div className="px-4 pt-3">
            <div className="gb-slip">
              <b>
                {overdueTotal} corrective {overdueTotal === 1 ? 'action is' : 'actions are'} overdue
              </b>
              <p>
                {grouped
                  .filter((unit) => unit.overdue > 0)
                  .map((unit) => `${unit.name} (${unit.overdue})`)
                  .join(', ')}
                . Their Zone Leaders are named on each row below.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setOverdue(true)}
                >
                  Show only these
                </button>
              </p>
            </div>
          </div>
        )}

        {actions.isLoading && <Spinner />}
        {actions.error && (
          <div className="p-4">
            <ErrorNotice error={actions.error} />
          </div>
        )}
        {actions.data && rows.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-3">No corrective actions match.</p>
        )}
        {actions.data && rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Status</Th>
                <Th>Zone Leader</Th>
                <Th>Due</Th>
                <Th>Opened</Th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((unit) => (
                <Fragment key={unit.unitId}>
                  <tr className="bg-tile-2">
                    <Td colSpan={5}>
                      <span className="gb-h2">{unit.name}</span>
                      <span className="ml-2 text-xs text-ink-3">
                        {unit.total} {unit.total === 1 ? 'action' : 'actions'}
                        {unit.overdue > 0 ? ` · ${unit.overdue} overdue` : ''}
                      </span>
                    </Td>
                  </tr>
                  {unit.audits.map((group) => (
                    <Fragment key={group.auditId}>
                      <tr className="bg-board">
                        <Td colSpan={5}>
                          <span className="text-xs font-medium text-ink-2">
                            {auditHeading(group.list[0]!, numbered.get(group.auditId)?.number)}
                          </span>
                          {group.overdue > 0 && (
                            <span className="ml-2 text-xs text-crit">
                              {group.overdue} overdue
                            </span>
                          )}
                        </Td>
                      </tr>
                      {group.list.map((action) => {
                        const late = isOverdue(action.status, action.dueAt, Date.now());
                        return (
                          <tr
                            key={action.id}
                            className="cursor-pointer hover:bg-board"
                            onClick={() => setSelected(action.id)}
                          >
                            <Td>
                              <span className="font-medium">
                                Zone {action.zoneCode} — {action.zoneName}
                              </span>
                              <div className="text-xs text-ink-3">{itemLabel(action)}</div>
                            </Td>
                            <Td>
                              <StatusBadge status={action.status} />
                              {action.reopenCount > 0 && (
                                <span className="ml-1 text-xs text-ink-3">
                                  reopened ×{action.reopenCount}
                                </span>
                              )}
                            </Td>
                            <Td>{action.assignedZoneLeaderName ?? '—'}</Td>
                            <Td>
                              {action.dueAt ? (
                                // The word as well as the colour: an overdue row has to
                                // survive a projector and a colour-blind reader.
                                <span className={late ? 'text-crit' : ''}>
                                  {new Date(action.dueAt).toLocaleDateString()}
                                  {late && <b className="ml-1">Overdue</b>}
                                </span>
                              ) : (
                                '—'
                              )}
                            </Td>
                            <Td>{new Date(action.openedAt).toLocaleDateString()}</Td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && <ActionPanel actionId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * The heading for one audit's findings. The number is the Unit's own sequence, matching
 * the picker and the Analytics tab; it is absent when the list is not filtered to a Unit,
 * because numbering audits across Units would invent a sequence that does not exist.
 */
function auditHeading(sample: CorrectiveAction, number: number | undefined): string {
  const when = sample.auditCompletedAt
    ? new Date(sample.auditCompletedAt).toLocaleDateString()
    : 'not completed';
  const kind = sample.auditType.replace(/_/g, ' ').toLowerCase();
  return number === undefined ? `${kind} · ${when}` : `Audit ${number} · ${kind} · ${when}`;
}

function ActionPanel({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const detail = useQuery({
    queryKey: ['corrective-action', actionId],
    queryFn: () => api.get<CorrectiveActionDetail>(`/corrective-actions/${actionId}`),
  });

  const refresh = async () => {
    setNote('');
    await queryClient.invalidateQueries({ queryKey: ['corrective-action', actionId] });
    await queryClient.invalidateQueries({ queryKey: ['corrective-actions'] });
    await queryClient.invalidateQueries({ queryKey: ['audits'] });
  };

  const review = useMutation({
    mutationFn: (outcome: 'verify' | 'reopen') =>
      api.post<CorrectiveActionDetail>(
        `/corrective-actions/${actionId}/${outcome}`,
        outcome === 'verify'
          ? { version: detail.data!.version, ...(note.trim() ? { comment: note.trim() } : {}) }
          : { version: detail.data!.version, reason: note.trim() },
      ),
    onSuccess: refresh,
  });

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  const action = detail.data!;

  const reviewable = can('corrective_action', 'verify') && awaitsReview(action.status);
  const reopenable = can('corrective_action', 'reopen') && (reviewable || action.status === 'VERIFIED');

  return (
    <Card>
      <CardHeader
        title={`Zone ${action.zoneCode} — ${action.zoneName}`}
        description={itemLabel(action)}
        action={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      />
      <div className="grid gap-4 p-4 md:grid-cols-[16rem_1fr]">
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">The finding</p>
          <Photo evidenceId={action.evidenceId} remark={action.findingRemark} alt="Nonconformity photograph" />
          {action.findingRemark && <p className="text-sm text-ink-2">{action.findingRemark}</p>}
          <dl className="grid grid-cols-2 gap-1 text-xs text-ink-2">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={action.status} />
            </dd>
            <dt>Assigned</dt>
            <dd>{action.assignedZoneLeaderName ?? '—'}</dd>
            <dt>Due</dt>
            <dd>{action.dueAt ? new Date(action.dueAt).toLocaleDateString() : '—'}</dd>
          </dl>
          {can('corrective_action', 'reassign') && action.status !== 'VERIFIED' && (
            <Reassign action={action} onDone={refresh} />
          )}
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">
            Submissions ({action.submissions.length})
          </p>
          {action.submissions.length === 0 && (
            <p className="text-sm text-ink-3">Nothing submitted yet.</p>
          )}
          {action.submissions.map((attempt) => (
            <Attempt key={attempt.id} attempt={attempt} />
          ))}

          {(reviewable || reopenable) && (
            <div className="space-y-2 border border-edge-soft p-3">
              <Field
                label={reviewable ? 'Comment, or the reason for reopening' : 'Reason for reopening'}
                hint="Reopening needs a reason; the Zone Leader sees it."
              >
                <Input value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
              {review.error && <ErrorNotice error={review.error} />}
              <div className="flex gap-2">
                {reviewable && (
                  <Button disabled={review.isPending} onClick={() => review.mutate('verify')}>
                    Verify
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={review.isPending || note.trim().length === 0}
                  onClick={() => review.mutate('reopen')}
                >
                  Reopen
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Attempt({ attempt }: { attempt: CorrectiveActionSubmission }) {
  return (
    <div className="border border-edge-soft p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Attempt {attempt.attemptNo}</span>
        <Badge tone={attempt.option === 'COMPLETED' ? 'good' : 'warn'}>
          {attempt.option === 'COMPLETED' ? 'Completed' : 'Not possible'}
        </Badge>
        <span className="text-xs text-ink-3">
          {attempt.submittedByName} · {new Date(attempt.createdAt).toLocaleString()} ·{' '}
          {attempt.submittedVia.replace('_', ' ').toLowerCase()}
        </span>
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-[10rem_1fr]">
        {attempt.afterEvidenceId && <Photo evidenceId={attempt.afterEvidenceId} alt="After photograph" />}
        <p className="text-sm whitespace-pre-line text-ink-2">
          {attempt.option === 'COMPLETED' ? attempt.description : attempt.explanation}
        </p>
      </div>
      {attempt.reviewOutcome && (
        <p className="mt-2 text-xs text-ink-2">
          <Badge tone={attempt.reviewOutcome === 'VERIFIED' ? 'good' : 'bad'}>
            {attempt.reviewOutcome === 'VERIFIED' ? 'Verified' : 'Reopened'}
          </Badge>{' '}
          {attempt.reviewedAt && new Date(attempt.reviewedAt).toLocaleString()}
          {attempt.reviewComment && ` — ${attempt.reviewComment}`}
        </p>
      )}
    </div>
  );
}

function Reassign({ action, onDone }: { action: CorrectiveActionDetail; onDone: () => Promise<void> }) {
  const [userId, setUserId] = useState('');
  const leaders = useQuery({
    queryKey: ['zone-leaders', action.unitId],
    queryFn: () =>
      api.get<Page<User>>(`/users?limit=200&role=ZONE_LEADER&status=ACTIVE&unitId=${action.unitId}`),
  });
  const reassign = useMutation({
    mutationFn: () => api.post(`/corrective-actions/${action.id}/reassign`, { zoneLeaderUserId: userId }),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-2 pt-2">
      <Field label="Reassign to">
        <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">Choose a Zone Leader</option>
          {leaders.data?.data
            .filter((leader) => leader.id !== action.assignedZoneLeaderUserId)
            .map((leader) => (
              <option key={leader.id} value={leader.id}>
                {leader.fullName}
              </option>
            ))}
        </Select>
      </Field>
      {reassign.error && <ErrorNotice error={reassign.error} />}
      <Button variant="secondary" disabled={!userId || reassign.isPending} onClick={() => reassign.mutate()}>
        Reassign
      </Button>
    </div>
  );
}

function Photo({ evidenceId, remark = null, alt }: { evidenceId: string; remark?: string | null; alt: string }) {
  const [open, setOpen] = useState(false);
  const thumbnail = useQuery({
    queryKey: ['evidence-view-url', evidenceId, 'thumbnail'],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidenceId}/view-url?variant=thumbnail`),
    staleTime: 240_000,
  });

  return (
    <>
      <button
        type="button"
        className="block w-full overflow-hidden border border-edge-soft hover:border-edge"
        aria-label={`Open ${alt.toLowerCase()}`}
        onClick={() => setOpen(true)}
      >
        {thumbnail.data ? (
          <img className="aspect-4/3 w-full object-cover" src={thumbnail.data.url} alt={alt} />
        ) : (
          <div className="grid aspect-4/3 place-items-center bg-tile-2 text-xs text-ink-3">
            {thumbnail.error ? 'Preview unavailable' : 'Loading…'}
          </div>
        )}
      </button>
      {open && <EvidenceViewer evidence={{ id: evidenceId, remark }} onClose={() => setOpen(false)} />}
    </>
  );
}

function StatusBadge({ status }: { status: CorrectiveActionStatus }) {
  const tone = status === 'VERIFIED' ? 'good' : status === 'REOPENED' ? 'bad' : awaitsReview(status) ? 'warn' : 'neutral';
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

function itemLabel(action: CorrectiveAction): string {
  if (action.questionGlobalOrder === null) return 'Walk-by observation';
  const section = action.section ? `${sectionLabel(action.section)} · ` : '';
  return `${section}Q${action.questionGlobalOrder}: ${action.questionText ?? ''}`;
}

const STATUS_LABEL: Record<CorrectiveActionStatus, string> = {
  OPEN: 'Open',
  ACTION_SUBMITTED: 'Submitted',
  NOT_POSSIBLE: 'Not possible',
  VERIFIED: 'Verified',
  REOPENED: 'Reopened',
};
