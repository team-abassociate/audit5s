import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CORRECTIVE_ACTION_STATUSES,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionStatus,
  type CorrectiveActionSubmission,
  type EvidenceViewUrl,
  type Page,
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
  const [selected, setSelected] = useState<string | null>(null);

  const actions = useQuery({
    queryKey: ['corrective-actions', status, overdue],
    queryFn: () =>
      api.get<Page<CorrectiveAction>>(
        `/corrective-actions?limit=200${status ? `&status=${status}` : ''}${overdue ? '&overdue=true' : ''}`,
      ),
    refetchInterval: 60_000,
  });

  const waiting = actions.data?.data.filter((action) => awaitsReview(action.status)).length ?? 0;

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

        {actions.isLoading && <Spinner />}
        {actions.error && (
          <div className="p-4">
            <ErrorNotice error={actions.error} />
          </div>
        )}
        {actions.data && actions.data.data.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-3">No corrective actions match.</p>
        )}
        {actions.data && actions.data.data.length > 0 && (
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
              {actions.data.data.map((action) => (
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
                      <span className="ml-1 text-xs text-ink-3">reopened ×{action.reopenCount}</span>
                    )}
                  </Td>
                  <Td>{action.assignedZoneLeaderName ?? '—'}</Td>
                  <Td>
                    {action.dueAt ? (
                      <span className={isOverdue(action.status, action.dueAt, Date.now()) ? 'text-crit' : ''}>
                        {new Date(action.dueAt).toLocaleDateString()}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{new Date(action.openedAt).toLocaleDateString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && <ActionPanel actionId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
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
