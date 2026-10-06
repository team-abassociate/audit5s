import { Fragment, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  CORRECTIVE_ACTION_STATUSES,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionLink,
  type CorrectiveActionStatus,
  type CorrectiveActionSummary,
  type CorrectiveActionSubmission,
  type EvidenceViewUrl,
  type Audit,
  type Page,
  type Unit,
  type User,
} from '@audit5s/contracts';
import {
  formatDate,
  formatDateTime,
  isOverdue,
  isReviewable,
  isUnapprovedClosure,
  zoneDisplayLabel,
} from '@audit5s/domain';
import { api } from '@/lib/api';
import { ACTION_STATUS_LABEL, SECTION_LABEL, SUBMISSION_CHANNEL_LABEL, auditTypeLabel, roleLabel } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { useFollowItemUnit, useUnitScope } from '@/lib/scope';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Select,
  SidePanel,
  Skeleton,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
  useRoutedPanel,
} from '@/components/ui';
import { EvidenceViewer } from '@/features/audits/AuditDetailPanel';
import { groupActions, leaderOf, overdueByLeader, type GroupKey, type SortKey } from './queue';

/** Rows per request; "Load more" asks for the next page (CA10). */
const PAGE = 100;

/** "Awaiting review": a "not possible" or a submission waiting for a decision (CA4). */
const REVIEW = 'REVIEW';
type StatusFilter = CorrectiveActionStatus | typeof REVIEW;

/** The page's URL (CA1, CA5): the open item, the filters, the order. Defaults are left out. */
export interface CorrectiveActionsSearch {
  action?: string;
  status?: StatusFilter;
  overdue?: true;
  audit?: string;
  sort?: Exclude<SortKey, 'due'>;
  group?: Exclude<GroupKey, 'audit'>;
  /** Development only: `?data=worst` swaps the API for the worst-case fixture (break-ui). */
  data?: 'worst';
}

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

export function validateCorrectiveActionsSearch(search: Record<string, unknown>): CorrectiveActionsSearch {
  const status = str(search.status);
  return {
    action: str(search.action),
    status:
      status === REVIEW || CORRECTIVE_ACTION_STATUSES.includes(status as CorrectiveActionStatus)
        ? (status as StatusFilter)
        : undefined,
    overdue: search.overdue === true || search.overdue === 'true' ? true : undefined,
    audit: str(search.audit),
    sort: search.sort === 'age' || search.sort === 'leader' ? search.sort : undefined,
    group: search.group === 'leader' ? 'leader' : undefined,
    data: import.meta.env.DEV && search.data === 'worst' ? 'worst' : undefined,
  };
}

/**
 * Reads go through here: the API, or in development with `?data=worst` the worst-case
 * fixture (long names, 1,000 rows), loaded only then so it never ships.
 */
function useLoad() {
  const { data } = useSearch({ strict: false }) as CorrectiveActionsSearch;
  const worst = import.meta.env.DEV && data === 'worst';
  const load = <T,>(path: string): Promise<T> =>
    worst ? import('./worst-case').then((fixture) => fixture.worstCase(path) as T) : api.get<T>(path);
  return { worst, load };
}

/**
 * Corrective actions (PART 14, Phase 6's Web row): the review queue — approve, and
 * disapprove (the reopen edge, R-40) — and the whole submission history. A Coordinator
 * reviews their own Unit's here as a Super Admin does (R-43).
 *
 * What a role may do is the server's answer (`/auth/me`), not this page's: the buttons
 * render from `can()`, and the API refuses anything else regardless.
 */
export function CorrectiveActionsPage() {
  const search = useSearch({ strict: false }) as CorrectiveActionsSearch;
  const navigate = useNavigate();
  const setSearch = (patch: Partial<CorrectiveActionsSearch>) =>
    void navigate({
      to: '.',
      search: ((prev: CorrectiveActionsSearch) => ({ ...prev, ...patch })) as never,
      replace: true,
      resetScroll: false,
    });
  const { worst, load } = useLoad();
  const panel = useRoutedPanel('action');
  const sort: SortKey = search.sort ?? 'due';
  const group: GroupKey = search.group ?? 'audit';
  const status = search.status ?? '';
  const overdue = search.overdue === true;

  // The Unit is the portal's scope, chosen in the shell's topbar (lib/scope.ts); `null`
  // there is "All Units" (or "All my Units" for a Consultant with several).
  const scope = useUnitScope();
  const unitId = scope.unitId ?? '';

  const units = useQuery({
    queryKey: ['units', worst],
    queryFn: () => load<Page<Unit>>('/units?limit=200'),
    staleTime: 5 * 60_000,
  });

  /**
   * The chosen Unit's completed audits, for the second filter. Numbered oldest-first so
   * "Audit 3" means the same thing here as on the Analytics tab; a Unit's third audit does
   * not become its fourth because a newer one arrived.
   */
  const audits = useQuery({
    queryKey: ['corrective-actions', 'audits', unitId, worst],
    queryFn: () => load<Page<Audit>>(`/audits?unitId=${unitId}&limit=200`),
    enabled: unitId !== '',
  });
  const completed = (audits.data?.data ?? [])
    .filter((audit) => audit.completedAt !== null)
    .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!));
  const numbered = new Map(completed.map((audit, index) => [audit.id, { audit, number: index + 1 }]));
  // An audit belongs to one Unit: a Unit change makes a stale `?audit=` mean nothing.
  const auditId =
    unitId !== '' && search.audit && (!audits.data || numbered.has(search.audit)) ? search.audit : '';

  // CA10: filtered, sorted, grouped and counted on the server; this page only lays it out.
  const filters = new URLSearchParams();
  if (status === REVIEW) filters.set('awaitingReview', 'true');
  else if (status) filters.set('status', status);
  if (overdue) filters.set('overdue', 'true');
  if (unitId) filters.set('unitId', unitId);
  if (auditId) filters.set('auditId', auditId);
  const listQuery = new URLSearchParams(filters);
  listQuery.set('sort', sort);
  listQuery.set('group', group);
  listQuery.set('limit', String(PAGE));

  const actions = useInfiniteQuery({
    queryKey: ['corrective-actions', listQuery.toString(), worst],
    // A filter change keeps the rows on screen until the new ones arrive.
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams(listQuery);
      if (pageParam) query.set('cursor', pageParam);
      return load<Page<CorrectiveAction>>(`/corrective-actions?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 60_000,
    enabled: scope.ready,
  });
  const summary = useQuery({
    queryKey: ['corrective-actions', 'summary', filters.toString(), worst],
    queryFn: () => load<CorrectiveActionSummary>(`/corrective-actions/summary?${filters}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled: scope.ready,
  });

  const rows = actions.data?.pages.flatMap((page) => page.data) ?? [];
  const totals = summary.data;
  const waiting = totals ? totals.byStatus.ACTION_SUBMITTED + totals.byStatus.NOT_POSSIBLE : 0;

  const unitName = (id: string) =>
    // A Consultant still reads their own audits' findings in a Unit they have since left.
    units.data?.data.find((unit) => unit.id === id)?.name ?? 'A Unit you are no longer on';
  const now = Date.now();
  const grouped = groupActions(rows, group, totals);
  const chase = overdueByLeader(totals);
  const overdueTotal = totals?.overdue ?? 0;
  const manyUnits = grouped.length > 1;
  const filtered = status !== '' || overdue || auditId !== '';

  return (
    <div className="gb-withpanel">
      <Card className="min-w-0">
        <CardHeader
          title="Corrective actions"
          description={
            'Every finding from a completed audit, until it is closed. The Zone Leader answers ' +
            'each one; you chase what is overdue and decide on what they could not fix.'
          }
          action={
            waiting > 0 && status !== REVIEW ? (
              <Button variant="secondary" onClick={() => setSearch({ status: REVIEW, overdue: undefined })}>
                {waiting} awaiting review
              </Button>
            ) : undefined
          }
        />
        <div className="gb-filters">
          <Field label="Audit" hint={unitId === '' ? 'Choose one Unit at the top of the page' : undefined}>
            <Select
              value={auditId}
              onChange={(event) => setSearch({ audit: event.target.value || undefined })}
              disabled={unitId === '' || numbered.size === 0}
            >
              <option value="">
                {unitId === ''
                  ? 'Every audit'
                  : numbered.size === 0
                    ? 'No completed audits'
                    : `Every audit · ${numbered.size}`}
              </option>
              {[...numbered.values()].reverse().map(({ audit, number }) => (
                <option key={audit.id} value={audit.id}>
                  {`Audit ${number} · ${formatDate(audit.completedAt)} · ${audit.auditorName}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={(event) => setSearch({ status: (event.target.value || undefined) as StatusFilter | undefined })}
            >
              <option value="">Any</option>
              <option value={REVIEW}>Awaiting review</option>
              {CORRECTIVE_ACTION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ACTION_STATUS_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sort">
            <Select
              value={sort}
              onChange={(event) =>
                setSearch({ sort: event.target.value === 'due' ? undefined : (event.target.value as 'age' | 'leader') })
              }
            >
              <option value="due">Due date, soonest first</option>
              <option value="age">Age, oldest first</option>
              <option value="leader">Zone Leader, A to Z</option>
            </Select>
          </Field>
          <Field label="Group">
            <Select
              value={group}
              onChange={(event) => setSearch({ group: event.target.value === 'leader' ? 'leader' : undefined })}
            >
              <option value="audit">By audit</option>
              <option value="leader">By Zone and leader</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(event) => setSearch({ overdue: event.target.checked ? true : undefined })}
            />
            Overdue only
          </label>
        </div>

        {/*
          The one thing on this page somebody must act on today. It names who to call, by Zone
          and leader (D3), because calling someone is the entire response to an overdue action.
        */}
        {overdueTotal > 0 && !overdue && (
          <div className="px-4 pt-3">
            <div className="gb-slip">
              <b>
                {overdueTotal} corrective {overdueTotal === 1 ? 'action is' : 'actions are'} overdue
              </b>
              <p>
                Who to chase:{' '}
                {chase
                  .slice(0, 3)
                  .map(
                    (entry, index, top) =>
                      // A Unit is named once, before its first Zone: Zone numbers repeat across Units.
                      `${manyUnits && top[index - 1]?.unitId !== entry.unitId ? `${unitName(entry.unitId)}: ` : ''}` +
                      `${entry.zone} — ${entry.leader ?? 'no Zone Leader on record'} (${entry.count})`,
                  )
                  .join('; ')}
                {chase.length > 3 ? `; and ${chase.length - 3} more` : ''}.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setSearch({ overdue: true, group: 'leader', status: undefined })}
                >
                  Show only these, by Zone and leader
                </button>
              </p>
            </div>
          </div>
        )}

        {(actions.isLoading || !scope.ready) && (
          <Skeleton variant="rows" columns={['Item', 'Status', 'Zone Leader', 'Due', 'Opened', 'Closed']} />
        )}
        {actions.error && (
          <div className="p-4">
            <ErrorNotice error={actions.error} />
          </div>
        )}
        {actions.data && rows.length === 0 && (
          <EmptyState
            title={filtered ? 'No corrective actions match these filters.' : 'No corrective actions.'}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => setSearch({ status: undefined, overdue: undefined, audit: undefined })}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {filtered ? undefined : 'A completed audit raises one for every nonconformity photograph.'}
          </EmptyState>
        )}
        {actions.data && rows.length > 0 && (
          <div className="gb-ca-list">
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>Status</Th>
                  <Th>Zone Leader</Th>
                  <Th>Due</Th>
                  <Th>Opened</Th>
                  <Th>Closed</Th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((unit) => (
                  <Fragment key={unit.unitId}>
                    <tr className="gb-group">
                      <Td colSpan={6}>
                        <span className="gb-group-title">{unitName(unit.unitId)}</span>
                        <span className="gb-group-meta">
                          {unit.total} {unit.total === 1 ? 'action' : 'actions'}
                          {unit.overdue > 0 ? ` · ${unit.overdue} overdue` : ''}
                        </span>
                      </Td>
                    </tr>
                    {unit.groups.map((entry) => (
                      <Fragment key={entry.key}>
                        <tr className="bg-board">
                          <Td colSpan={6}>
                            <span className="text-xs font-medium text-ink-2">
                              {entry.auditId !== null
                                ? auditHeading(entry.list[0]!, numbered.get(entry.auditId)?.number)
                                : `${entry.zone} · ${entry.leader ?? 'No Zone Leader on record'}`}
                            </span>
                            {entry.overdue > 0 && (
                              <span className="ml-2 text-xs font-semibold gb-text-crit">{entry.overdue} overdue</span>
                            )}
                            {/* The rest of a group is on the next page; it continues under this header. */}
                            {entry.list.length < entry.total && (
                              <span className="ml-2 text-xs text-ink-3">
                                {entry.list.length} of {entry.total} shown
                              </span>
                            )}
                          </Td>
                        </tr>
                        {entry.list.map((action) => (
                          <ActionRow
                            key={action.id}
                            action={action}
                            leader={leaderOf(action)}
                            now={now}
                            open={panel.id === action.id}
                            onOpen={() => panel.open(action.id)}
                          />
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {actions.hasNextPage && (
          <div className="flex flex-wrap items-center gap-3 p-4">
            <Button
              variant="secondary"
              disabled={actions.isFetchingNextPage}
              onClick={() => void actions.fetchNextPage()}
            >
              {actions.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
            {totals && (
              <span className="text-sm text-ink-2" aria-live="polite">
                {rows.length.toLocaleString('en-IN')} of {totals.total.toLocaleString('en-IN')} shown
              </span>
            )}
          </div>
        )}
      </Card>

      <ActionPanel actionId={panel.id} onClose={panel.close} />
    </div>
  );
}

function ActionRow({
  action,
  leader,
  now,
  open,
  onOpen,
}: {
  action: CorrectiveAction;
  leader: string | null;
  now: number;
  open: boolean;
  onOpen: () => void;
}) {
  const late = isOverdue(action.status, action.dueAt, now);
  return (
    <tr
      className={open ? 'gb-row--open cursor-pointer' : 'cursor-pointer'}
      onClick={(event) => {
        // The title is the keyboard's way in (a button); the rest of the row is the mouse's.
        if ((event.target as Element).closest('button, a')) return;
        onOpen();
      }}
    >
      <Td>
        <button type="button" className="gb-rowtoggle" aria-current={open ? 'true' : undefined} onClick={onOpen}>
          {zoneDisplayLabel(action.zoneCode, action.zoneName)}
        </button>
        <div className="text-xs text-ink-3">{itemLabel(action)}</div>
      </Td>
      <Td>
        <StatusChip kind="action" status={action.status} />
        {action.reopenCount > 0 && <div className="mt-1 text-xs whitespace-nowrap text-ink-3">reopened ×{action.reopenCount}</div>}
      </Td>
      <Td>{leader ?? '—'}</Td>
      <Td className="gb-data">
        {action.dueAt ? (
          // The word as well as the colour: an overdue row has to survive a projector and a
          // colour-blind reader.
          <span className={late ? 'gb-text-crit' : ''}>
            {formatDate(action.dueAt)}
            {late && <b className="ml-1">Overdue</b>}
          </span>
        ) : (
          '—'
        )}
      </Td>
      <Td className="gb-data">{formatDate(action.openedAt)}</Td>
      <Td>
        <Closed action={action} />
      </Td>
    </tr>
  );
}

/**
 * The heading for one audit's findings. The number is the Unit's own sequence, matching
 * the picker and the Analytics tab; it is absent when the list is not filtered to a Unit,
 * because numbering audits across Units would invent a sequence that does not exist.
 */
function auditHeading(sample: CorrectiveAction, number: number | undefined): string {
  const when = sample.auditCompletedAt ? formatDate(sample.auditCompletedAt) : 'not completed';
  const kind = auditTypeLabel(sample.auditType);
  // The auditor's name, because the question asked of every finding in this list is which
  // audit it came out of — and a date and a kind do not answer that when two Consultants
  // audited the same Unit the same week. Omitted rather than faked when the read that
  // resolves it found nothing.
  const who = sample.auditorName ? ` · ${sample.auditorName}` : '';
  return number === undefined
    ? `${kind} · ${when}${who}`
    : `Audit ${number} · ${kind} · ${when}${who}`;
}

function ActionPanel({ actionId, onClose }: { actionId: string | null; onClose: () => void }) {
  const { worst, load } = useLoad();
  const detail = useQuery({
    queryKey: ['corrective-action', actionId, worst],
    queryFn: () => load<CorrectiveActionDetail>(`/corrective-actions/${actionId}`),
    enabled: actionId !== null,
  });
  const action = detail.data;
  useFollowItemUnit(actionId, action?.id === actionId ? action.unitId : undefined);

  return (
    <SidePanel
      open={actionId !== null}
      title={action ? zoneDisplayLabel(action.zoneCode, action.zoneName) : 'Corrective action'}
      subtitle={action ? itemLabel(action) : undefined}
      onClose={onClose}
    >
      {detail.isLoading && <Spinner />}
      {detail.error && (
        <ErrorNotice error={detail.error} missing="This corrective action doesn't exist, or was removed." />
      )}
      {action && (
        <ActionDetail
          key={action.id}
          action={action}
          leader={leaderOf(action)}
        />
      )}
    </SidePanel>
  );
}

function ActionDetail({ action, leader }: { action: CorrectiveActionDetail; leader: string | null }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const refresh = async () => {
    setNote('');
    await queryClient.invalidateQueries({ queryKey: ['corrective-action', action.id] });
    await queryClient.invalidateQueries({ queryKey: ['corrective-actions'] });
    await queryClient.invalidateQueries({ queryKey: ['audits'] });
  };

  const review = useMutation({
    mutationFn: (outcome: 'verify' | 'reopen') =>
      api.post<CorrectiveActionDetail>(
        `/corrective-actions/${action.id}/${outcome}`,
        outcome === 'verify'
          ? { version: action.version, ...(note.trim() ? { comment: note.trim() } : {}) }
          : { version: action.version, reason: note.trim() },
      ),
    onSuccess: refresh,
  });

  // R-43: a "not possible" waits for a decision; a Zone Leader's closure may be approved, and
  // need not be. Either may be disapproved, which is the reopen edge (R-40).
  const reviewable = can('corrective_action', 'verify') && isReviewable(action.status, action.verifiedByUserId);
  const closure = isUnapprovedClosure(action.status, action.verifiedByUserId);
  const reopenable = can('corrective_action', 'reopen') && (reviewable || action.status === 'VERIFIED');
  // CA7: the button names what approving does to *this* item.
  const approveLabel =
    action.status === 'NOT_POSSIBLE' ? 'Accept as not possible' : closure ? 'Approve closure' : 'Approve';

  return (
    <div className="space-y-4">
      {action.evidenceId ? (
        <div className="space-y-2">
          <p className="gb-label">The finding</p>
          <div className="max-w-sm">
            <Photo evidenceId={action.evidenceId} remark={action.findingRemark} alt="Nonconformity photograph" />
          </div>
          {action.findingRemark && <p className="text-sm text-ink-2">{action.findingRemark}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {/* R-38: an overall suggestion has no photograph — the words are the finding. */}
          <p className="gb-label">Overall suggestion</p>
          <p className="text-sm whitespace-pre-wrap text-ink">{action.suggestion}</p>
        </div>
      )}
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm text-ink-2">
        <dt>Status</dt>
        <dd>
          <StatusChip kind="action" status={action.status} />
        </dd>
        <dt>Auditor</dt>
        <dd>{action.auditorName ?? '—'}</dd>
        <dt>Zone Leader</dt>
        <dd>{leader ?? '—'}</dd>
        <dt>Due</dt>
        <dd>{formatDate(action.dueAt)}</dd>
        {action.status === 'VERIFIED' && (
          <>
            <dt>Closed by</dt>
            <dd>{action.closedByName ?? '—'}</dd>
            <dt>Closed at</dt>
            <dd>{action.resolvedAt ? formatDateTime(action.resolvedAt) : '—'}</dd>
            <dt>Reviewed</dt>
            <dd>{closure ? 'Not reviewed' : `Approved by ${action.verifiedByName ?? '—'}`}</dd>
          </>
        )}
      </dl>
      {can('corrective_action', 'reassign') && action.status !== 'VERIFIED' && action.status !== 'WITHDRAWN' && (
        <Reassign action={action} onDone={refresh} />
      )}
      {can('corrective_action', 'link') && action.status !== 'VERIFIED' && action.status !== 'WITHDRAWN' && (
        <CopyLink actionId={action.id} listed={can('report_access_token', 'mint')} />
      )}

      <div className="space-y-3">
        <p className="gb-label">Answers ({action.submissions.length})</p>
        {action.submissions.length === 0 && <p className="text-sm text-ink-2">Nothing submitted yet.</p>}
        {action.submissions.map((attempt) => (
          <Attempt key={attempt.id} attempt={attempt} />
        ))}

        {(reviewable || reopenable) && (
          <div className="space-y-2 border border-edge-soft p-3">
            {/* R-40, R-43: disapproving is the reopen edge. Nothing is erased — the attempt
                stays above, marked Disapproved — but the item waits for a new answer, the
                same link in the PDF takes it, and a regenerated report prints the
                disapproval in place of the rejected answer. */}
            {closure && (
              <p className="text-sm text-ink-2">
                Closed by the Zone Leader. It already counts as closed and is in the after-evidence report;
                reviewing it is optional.
              </p>
            )}
            {action.status === 'NOT_POSSIBLE' && (
              <p className="text-sm text-ink-2">
                The Zone Leader says this cannot be fixed. Accepting closes it; disapproving sends it back
                for a new answer.
              </p>
            )}
            <Field
              label={reviewable ? 'Note' : 'Reason for disapproving'}
              hint={
                reviewable
                  ? 'Optional when you approve. Needed to disapprove: the Zone Leader sees it, then answers again from the same link in the PDF or from the field app.'
                  : 'The Zone Leader sees it, then answers again from the same link in the PDF or from the field app.'
              }
            >
              <Input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            {review.error && <ErrorNotice error={review.error} />}
            <div className="flex flex-wrap items-center gap-2">
              {reviewable && (
                <Button disabled={review.isPending} onClick={() => review.mutate('verify')}>
                  {approveLabel}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={review.isPending || note.trim().length === 0}
                onClick={() => review.mutate('reopen')}
              >
                Disapprove
              </Button>
              {note.trim().length === 0 && (
                <span className="text-xs text-ink-2" role="status">
                  Write a note to disapprove.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * CA9: the link in the PDF is stored only as a hash, so it cannot be shown again. This makes
 * one more link to the same item and copies it; the printed one keeps working, and both are
 * listed with the report's links on Reports, where either can be revoked. A Coordinator
 * makes links too (R-47) but has no Reports page, so `listed` is false for them.
 */
function CopyLink({ actionId, listed }: { actionId: string; listed: boolean }) {
  const [copied, setCopied] = useState(false);
  const make = useMutation({
    // One key per press: a retried request mints nothing twice.
    mutationFn: () => api.post<CorrectiveActionLink>(`/corrective-actions/${actionId}/link`, undefined, crypto.randomUUID()),
    onSuccess: async (link) => {
      if (!link.url) return;
      try {
        await navigator.clipboard.writeText(link.url);
        setCopied(true);
      } catch {
        setCopied(false); // No clipboard here: the link is shown below to copy by hand.
      }
    },
  });
  const url = make.data?.url;
  return (
    <div className="space-y-2">
      <p className="gb-label">Zone Leader link</p>
      {url ? (
        <>
          <Input readOnly value={url} aria-label="Zone Leader link" onFocus={(event) => event.currentTarget.select()} />
          <p className="text-sm text-ink-2" role="status">
            {copied ? 'Copied. ' : 'Select the link to copy it. '}
            This is a new link; the one in the PDF still works.{listed ? ' Both are listed with the report on Reports.' : ''}
          </p>
        </>
      ) : (
        <>
          <Button variant="secondary" disabled={make.isPending} onClick={() => make.mutate()}>
            {make.isPending ? 'Making a link…' : 'Copy Zone Leader link'}
          </Button>
          <p className="text-xs text-ink-2">
            Makes a new link to this item for you to send. The link in the PDF keeps working.
          </p>
        </>
      )}
      {make.error && <ErrorNotice error={make.error} />}
    </div>
  );
}

function Attempt({ attempt }: { attempt: CorrectiveActionSubmission }) {
  return (
    <div className="border border-edge-soft p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Attempt {attempt.attemptNo}</span>
        <StatusChip shape={attempt.option === 'COMPLETED' ? 'done' : 'attention'}>
          {attempt.option === 'COMPLETED' ? 'Completed' : 'Not possible'}
        </StatusChip>
        <span className="text-xs text-ink-3">
          {attempt.submittedByName} · {formatDateTime(attempt.createdAt)} · via{' '}
          {SUBMISSION_CHANNEL_LABEL[attempt.submittedVia]}
        </span>
      </div>
      <div className={attempt.afterEvidenceId ? 'mt-2 grid gap-3 sm:grid-cols-[10rem_1fr]' : 'mt-2'}>
        {attempt.afterEvidenceId && <Photo evidenceId={attempt.afterEvidenceId} alt="After photograph" />}
        <p className="text-sm whitespace-pre-line text-ink-2">
          {attempt.option === 'COMPLETED' ? attempt.description : attempt.explanation}
        </p>
      </div>
      {attempt.reviewOutcome && (
        <p className="mt-2 text-xs text-ink-2">
          <StatusChip shape={attempt.reviewOutcome === 'VERIFIED' ? 'done' : 'ended'}>
            {attempt.reviewOutcome === 'VERIFIED' ? 'Approved' : 'Disapproved'}
          </StatusChip>{' '}
          {attempt.reviewedByName &&
            `${attempt.reviewedByName}${attempt.reviewedByRole ? ` (${roleLabel(attempt.reviewedByRole)})` : ''} · `}
          {attempt.reviewedAt && formatDateTime(attempt.reviewedAt)}
          {attempt.reviewComment && ` — ${attempt.reviewComment}`}
        </p>
      )}
    </div>
  );
}

function Reassign({ action, onDone }: { action: CorrectiveActionDetail; onDone: () => Promise<void> }) {
  const { worst, load } = useLoad();
  const [userId, setUserId] = useState('');
  const leaders = useQuery({
    queryKey: ['zone-leaders', action.unitId, worst],
    queryFn: () => load<Page<User>>(`/users?limit=200&role=ZONE_LEADER&status=ACTIVE&unitId=${action.unitId}`),
  });
  const reassign = useMutation({
    mutationFn: () => api.post(`/corrective-actions/${action.id}/reassign`, { zoneLeaderUserId: userId }),
    onSuccess: onDone,
  });
  const options = (leaders.data?.data ?? []).filter((leader) => leader.id !== action.assignedZoneLeaderUserId);

  // CA2: a leader typed on the Zone has no account, so there may be nobody to pick. Say so
  // rather than offer an empty list.
  if (leaders.data && options.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        Nobody else to reassign to: this Unit has no other Zone Leader accounts. Any Zone Leader of the
        Unit may still answer it.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Reassign to">
        <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">Choose a Zone Leader</option>
          {options.map((leader) => (
            <option key={leader.id} value={leader.id}>
              {leader.fullName}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="secondary" disabled={!userId || reassign.isPending} onClick={() => reassign.mutate()}>
        Reassign
      </Button>
      {reassign.error && <ErrorNotice error={reassign.error} />}
    </div>
  );
}

function Photo({ evidenceId, remark = null, alt }: { evidenceId: string; remark?: string | null; alt: string }) {
  const [open, setOpen] = useState(false);
  const { worst, load } = useLoad();
  const thumbnail = useQuery({
    queryKey: ['evidence-view-url', evidenceId, 'thumbnail', worst],
    queryFn: () => load<EvidenceViewUrl>(`/evidence/${evidenceId}/view-url?variant=thumbnail`),
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

/**
 * R-39: who closed it and when — the question a Coordinator asks of a finished item. Only
 * a VERIFIED action is closed; a withdrawn one was settled without anybody's work.
 */
function Closed({ action }: { action: CorrectiveAction }) {
  if (action.status !== 'VERIFIED' || !action.resolvedAt) return <>—</>;
  return (
    <span>
      {action.closedByName ?? '—'}
      <div className="text-xs text-ink-3">{formatDateTime(action.resolvedAt)}</div>
      {/* R-43: closed is not verified — say whether anybody approved it. */}
      <div className="text-xs text-ink-3">
        {isUnapprovedClosure(action.status, action.verifiedByUserId)
          ? 'Not reviewed'
          : `✓ Approved by ${action.verifiedByName ?? '—'}`}
      </div>
    </span>
  );
}

function itemLabel(action: CorrectiveAction): string {
  if (action.suggestionNo) return `Overall action ${action.suggestionNo}: ${action.suggestion ?? ''}`;
  if (action.questionGlobalOrder === null) return 'Walk-by observation';
  const section = action.section ? `${SECTION_LABEL[action.section]} · ` : '';
  return `${section}Q${action.questionGlobalOrder}: ${action.questionText ?? ''}`;
}

