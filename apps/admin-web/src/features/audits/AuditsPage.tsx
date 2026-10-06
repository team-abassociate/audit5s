import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Audit,
  AuditAssignment,
  AuditDetail,
  AuditStatus,
  CreateAuditAssignmentRequest,
  MembershipDetail,
  Page,
  Unit,
  User,
  Zone,
} from '@audit5s/contracts';
import { formatDate, formatDateTime, zoneDisplayLabel, formatScore } from '@audit5s/domain';
import { bandTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { ApiError, api } from '@/lib/api';
import {
  Button,
  Card,
  CardHeader,
  Combobox,
  Dialog,
  DialogActions,
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
  useDialogClose,
  useRoutedPanel,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { useFollowItemUnit, useUnitScope } from '@/lib/scope';
import { AUDIT_STATUS_LABEL, AUDIT_TYPE_LABEL } from '@/lib/labels';
import { AuditDetailPanel } from './AuditDetailPanel';
import { AuditProgress, TeamProgress } from './AuditProgress';
import { read, readAll } from './data';

/**
 * `/audits?audit=…` opens that audit's panel; `?assignment=…` opens an assignment's progress
 * (where a notification sends someone); `?status=` is the status filter.
 */
export interface AuditsSearch {
  audit?: string;
  assignment?: string;
  status?: StatusFilter;
}

/** AU3: the lifecycle in the four groups a reviewer asks for, plus All (the default). */
const STATUS_FILTERS = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'active', label: 'Under way', statuses: ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'] },
  { id: 'actions', label: 'Actions open', statuses: ['CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED'] },
  { id: 'done', label: 'Done', statuses: ['COMPLETED', 'CLOSED'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; statuses: readonly AuditStatus[] | null }>;

export type StatusFilter = (typeof STATUS_FILTERS)[number]['id'];

export function isStatusFilter(value: unknown): value is StatusFilter {
  return STATUS_FILTERS.some((filter) => filter.id === value);
}

/** AU8: what each status means, in the order an audit lives through them. */
const STATUS_MEANING: Array<[AuditStatus, string]> = [
  ['ASSIGNED', 'Given to an auditor; not started on the phone yet.'],
  ['READY', 'The auditor has checked in; no Zone answered yet.'],
  ['IN_PROGRESS', 'The auditor is answering on the phone.'],
  ['PAUSED', 'Stopped part-way; it resumes where it left off.'],
  ['COMPLETED', 'Finished. Corrective actions are being raised.'],
  ['CORRECTIVE_ACTION_OPEN', 'Finished, with corrective actions still to be answered.'],
  ['PARTIALLY_CLOSED', 'Some corrective actions are closed, others still open.'],
  ['CLOSED', 'Every corrective action is closed, or there were none.'],
  ['CANCELLED', 'Stopped by a Super Admin. Everything recorded is kept; it has no score.'],
];

/*
 * AU12: the register narrows by its own width (a container query), so the same rule holds
 * beside the open panel and on a phone. Updated goes first, then the Auditor column, whose
 * name moves under the Unit. With those gone it fits, so the page's tables drop the flush
 * table's 640px minimum (an unlayered rule, hence `!`) instead of scrolling a column out of sight.
 */
const TABLES_FIT = '[&_table]:min-w-0!';
const HIDE_UPDATED = '@max-[46rem]:hidden';
const HIDE_AUDITOR = '@max-[34rem]:hidden';
const SHOW_AUDITOR = '@min-[34rem]:hidden';

/**
 * The audit register (§2.1 step 10) and assignment creation.
 *
 * Everything on this page is scope-filtered by the server: `GET /audits` returns whatever
 * the actor's resolver admits, so a Coordinator sees their Unit's audits and a Consultant
 * their own read-only history — from the same component. The status chips and the search
 * narrow that answer on the client; they never widen it.
 *
 * One action per row (AU14): the row, or its Unit name, opens the audit in the side panel,
 * routed as `?audit=<id>` so a link, a reload and Back all work (AU1).
 */
export function AuditsPage() {
  const { scope, can } = useSession();
  const search = useSearch({ strict: false }) as AuditsSearch;
  const navigate = useNavigate();
  const panel = useRoutedPanel('audit');
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const [expandedAssignment, setExpandedAssignment] = useState<string | null>(
    search.assignment ?? null,
  );
  const status: StatusFilter = search.status ?? 'all';
  const setStatus = (next: StatusFilter) =>
    void navigate({
      to: '.',
      search: ((prev: AuditsSearch) => ({ ...prev, status: next === 'all' ? undefined : next })) as never,
      replace: true,
      resetScroll: false,
    });

  // Arriving from a second notification while already on this page re-targets it.
  useEffect(() => {
    if (search.assignment) setExpandedAssignment(search.assignment);
  }, [search.assignment]);

  // AU9: the shell's Unit scope. `null` is "All Units" (or "All my Units"); a Coordinator's one
  // Unit is fixed. The server narrows to the caller's Units either way.
  const unitScope = useUnitScope();
  const unitParam = unitScope.unitId ? `&unitId=${unitScope.unitId}` : '';

  const audits = useQuery({
    enabled: unitScope.ready,
    queryKey: ['audits', 'register', unitScope.unitId],
    queryFn: () => readAll<Audit>(`/audits?limit=200${unitParam}`),
    // The register is also the live view of what is happening in the plants right now.
    refetchInterval: 30_000,
  });

  const assignments = useQuery({
    enabled: unitScope.ready,
    queryKey: ['audit-assignments', 'register', unitScope.unitId],
    queryFn: () => read<Page<AuditAssignment>>(`/audit-assignments?open=true&limit=200${unitParam}`),
  });

  // The open audit's own read, shared with the panel body (same key), for the panel's title.
  const opened = useQuery({
    enabled: panel.id !== null,
    queryKey: ['audit', panel.id],
    queryFn: () => read<AuditDetail>(`/audits/${panel.id}`),
  });
  useFollowItemUnit(panel.id, opened.data?.id === panel.id ? opened.data.unitId : undefined);

  const isConsultant = scope?.role === 'CONSULTANT';

  // AU4: most recently updated first, and the description says so.
  const auditRows = useMemo(
    () => [...(audits.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [audits.data],
  );
  const assignmentRows = useMemo(
    () =>
      [...(assignments.data?.data ?? [])].sort(
        (a, b) =>
          // A team's assignments stay together, newest team first.
          b.createdAt.localeCompare(a.createdAt) || (a.groupId ?? a.id).localeCompare(b.groupId ?? b.id),
      ),
    [assignments.data],
  );

  // AU9: the search narrows first, so each chip counts what it would show.
  const matching = useMemo(() => {
    const needle = text.trim().toLocaleLowerCase();
    if (!needle) return auditRows;
    return auditRows.filter((audit) =>
      [audit.unitName, audit.auditorName, AUDIT_TYPE_LABEL[audit.auditType]].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [auditRows, text]);
  const inFilter = (filter: (typeof STATUS_FILTERS)[number], audit: Audit) =>
    filter.statuses === null || (filter.statuses as readonly AuditStatus[]).includes(audit.status);
  const current = STATUS_FILTERS.find((filter) => filter.id === status) ?? STATUS_FILTERS[0];
  const shown = matching.filter((audit) => inFilter(current, audit));
  const filtered = status !== 'all' || text.trim() !== '';

  /** The auditors of each team, from whichever list names them. */
  const teams = useMemo(() => {
    const byGroup = new Map<string, { audits: Audit[]; assignments: AuditAssignment[] }>();
    const team = (groupId: string) => {
      const found = byGroup.get(groupId) ?? { audits: [], assignments: [] };
      byGroup.set(groupId, found);
      return found;
    };
    for (const audit of auditRows) if (audit.assignmentGroupId) team(audit.assignmentGroupId).audits.push(audit);
    for (const assignment of assignmentRows) if (assignment.groupId) team(assignment.groupId).assignments.push(assignment);
    return byGroup;
  }, [auditRows, assignmentRows]);

  const teamSize = (groupId: string | null | undefined) => {
    if (!groupId) return 1;
    const team = teams.get(groupId);
    return new Set([
      ...(team?.audits ?? []).map((audit) => audit.auditorUserId),
      ...(team?.assignments ?? []).map((assignment) => assignment.auditorUserId),
    ]).size;
  };

  const openAudit = opened.data;
  const openTeam =
    openAudit?.assignmentGroupId && teamSize(openAudit.assignmentGroupId) > 1
      ? teams.get(openAudit.assignmentGroupId)
      : undefined;

  return (
    <div className="gb-withpanel">
      <div className={cn('@container min-w-0 space-y-4', TABLES_FIT)}>
        <Card>
          <CardHeader
            title={isConsultant ? 'My audits' : 'Audits'}
            description={
              isConsultant
                ? 'Every audit you conducted, most recently updated first. Read-only: the official report is a Super Admin deliverable.'
                : 'Most recently updated first. Open an audit for its scores, every answer with its question, and its photos.'
            }
            action={
              can('audit_assignment', 'create') ? (
                <Button onClick={() => setCreating(true)}>New audit</Button>
              ) : undefined
            }
          />

          <div className="gb-filters" role="search" aria-label="Filter audits">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
              {STATUS_FILTERS.map((filter) => (
                <Button
                  key={filter.id}
                  variant={status === filter.id ? 'primary' : 'secondary'}
                  aria-pressed={status === filter.id}
                  onClick={() => setStatus(filter.id)}
                >
                  {filter.label}{' '}
                  <span className="gb-data">
                    {audits.data ? matching.filter((audit) => inFilter(filter, audit)).length : '…'}
                  </span>
                </Button>
              ))}
            </div>
            <div className="gb-filters-search">
              <Field label="Search">
                <Input
                  type="search"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Unit, auditor or type…"
                />
              </Field>
            </div>
            <span className="gb-filters-count" aria-live="polite">
              {audits.data
                ? filtered
                  ? `Showing ${shown.length} of ${auditRows.length} audits`
                  : `${auditRows.length} audit${auditRows.length === 1 ? '' : 's'}`
                : ''}
            </span>
          </div>

          <details className="border-b border-edge-soft px-4 py-2 text-sm">
            <summary className="cursor-pointer text-ink-2">What the statuses mean</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-2 pb-2 sm:grid-cols-[auto_1fr]">
              {STATUS_MEANING.map(([value, meaning]) => (
                <Fragment key={value}>
                  <dt>
                    <StatusChip kind="audit" status={value} />
                  </dt>
                  <dd className="text-ink-2">{meaning}</dd>
                </Fragment>
              ))}
            </dl>
          </details>

          {audits.isPending && (
            <Skeleton
              variant="rows"
              columns={['Unit', 'Auditor', 'Status', 'Score', 'Updated']}
              label="Loading audits…"
            />
          )}
          {audits.error && (
            <div className="p-4">
              <ErrorNotice error={audits.error} />
            </div>
          )}

          {audits.data && shown.length === 0 && (
            <EmptyState
              title={auditRows.length === 0 ? 'No audits yet.' : 'No audits match these filters.'}
              action={
                filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setText('');
                      setStatus('all');
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {auditRows.length === 0
                ? 'An audit appears here once an auditor starts it on the phone.'
                : undefined}
            </EmptyState>
          )}

          {shown.length > 0 && (
            <Table variant="register" label="Audits">
              <thead>
                <tr>
                  <Th width="30%">Unit</Th>
                  <Th width="20%" className={HIDE_AUDITOR}>
                    Auditor
                  </Th>
                  <Th width="19%">Status</Th>
                  <Th width="12%">Score</Th>
                  <Th width="19%" className={HIDE_UPDATED}>
                    Updated
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((audit) => {
                  const selected = panel.id === audit.id;
                  const size = teamSize(audit.assignmentGroupId);
                  return (
                    <tr
                      key={audit.id}
                      ref={selected ? scrollIntoViewOnce : undefined}
                      onClick={rowToggleProps(() => panel.open(audit.id)).onClick}
                      className={cn('cursor-pointer', selected && 'gb-row--open')}
                    >
                      <Td>
                        <button
                          type="button"
                          className="gb-rowtoggle"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => panel.open(audit.id)}
                        >
                          {audit.unitName}
                        </button>
                        <span className="block text-xs text-ink-3">
                          {AUDIT_TYPE_LABEL[audit.auditType]}
                          <span className={SHOW_AUDITOR}> · {audit.auditorName}</span>
                        </span>
                      </Td>
                      <Td className={HIDE_AUDITOR}>
                        {audit.auditorName}
                        {size > 1 && <span className="block text-xs text-ink-3">team of {size}</span>}
                      </Td>
                      <Td>
                        <StatusChip kind="audit" status={audit.status} />
                      </Td>
                      <Td>
                        <ScoreCell audit={audit} />
                      </Td>
                      {/* The mono face on a span, not the cell: a `td.gb-data` never wraps, and a
                          narrow column must break the date at its spaces, never truncate it. */}
                      <Td className={cn('text-ink-2', HIDE_UPDATED)}>
                        <span className="gb-data">{formatDateTime(audit.updatedAt)}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        {!isConsultant && assignmentRows.length > 0 && (
          <Card>
            <CardHeader
              title="Open assignments"
              description="Assigned audits not yet completed, newest first. Open one to see how far its auditors have got, or to cancel it. Removing someone from a Unit cancels their assignments there; nothing is deleted."
            />
            <Table>
              <thead>
                <tr>
                  <Th>Unit</Th>
                  <Th>Auditor</Th>
                  <Th>Due</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {assignmentRows.map((assignment) => (
                  <AssignmentRow
                    key={assignment.id}
                    assignment={assignment}
                    team={assignment.groupId ? teams.get(assignment.groupId)?.assignments ?? [] : []}
                    targeted={assignment.id === search.assignment}
                    open={expandedAssignment === assignment.id}
                    onToggle={() =>
                      setExpandedAssignment(expandedAssignment === assignment.id ? null : assignment.id)
                    }
                  />
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        {can('audit_assignment', 'create') && (
          <NewAuditDialog open={creating} onClose={() => setCreating(false)} />
        )}
      </div>

      <SidePanel
        open={panel.id !== null}
        title={openAudit ? openAudit.unitName : 'Audit'}
        subtitle={
          openAudit
            ? `${AUDIT_TYPE_LABEL[openAudit.auditType]} · ${openAudit.auditorName} · ${AUDIT_STATUS_LABEL[openAudit.status]}`
            : undefined
        }
        onClose={panel.close}
      >
        {panel.id ? (
          <AuditDetailPanel
            auditId={panel.id}
            team={
              openTeam && openAudit
                ? { unitId: openAudit.unitId, audits: openTeam.audits, pending: pendingAuditors(openTeam) }
                : undefined
            }
          />
        ) : null}
      </SidePanel>
    </div>
  );
}

/** Team members with an open assignment and no audit on the board yet. */
function pendingAuditors(team: { audits: Audit[]; assignments: AuditAssignment[] } | undefined): string[] {
  if (!team) return [];
  const started = new Set(team.audits.map((audit) => audit.assignmentId));
  return team.assignments
    .filter((assignment) => !started.has(assignment.id))
    .map((assignment) => assignment.auditorName);
}

/** Brings a deep-linked row into view, once, when it first renders. */
function scrollIntoViewOnce(row: HTMLTableRowElement | null) {
  if (!row || row.dataset.scrolled) return;
  row.dataset.scrolled = '1';
  requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
}

/**
 * The click target that expands a row: a real button, so it is reachable by keyboard and
 * announces its state, styled as the row's own label rather than as a second button.
 */
export function RowToggle({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="gb-rowtoggle" aria-expanded={open} onClick={onClick}>
      <span className="gb-rowtoggle-chev" aria-hidden>
        ▸
      </span>
      {children}
    </button>
  );
}

/**
 * Props that let a click anywhere on a row open it, not just on its `RowToggle`. A click
 * that lands on a control in the row — the toggle itself, Edit, Archive — is that
 * control's, and a drag that selects text is a copy, not a toggle.
 */
export function rowToggleProps(onToggle: () => void) {
  return {
    className: 'cursor-pointer',
    onClick: (event: MouseEvent<HTMLTableRowElement>) => {
      if ((event.target as Element).closest('button, a, input, select, textarea, label')) return;
      if (window.getSelection()?.toString()) return;
      onToggle();
    },
  };
}

/**
 * A score cell. `null` prints `N/A`, never `0%` (D4) — a Zone with nothing applicable has
 * no percentage, and showing zero would report a failure that did not happen. A cancelled
 * audit has no score at all (AU8): what it recorded is kept, but it was never finished.
 */
function ScoreCell({ audit }: { audit: Audit }) {
  if (!audit.scored) {
    return <span className="text-ink-3">Not scored</span>;
  }
  if (audit.status === 'CANCELLED' || (audit.status !== 'COMPLETED' && audit.totals.maxScore === 0)) {
    return <span className="text-ink-3">—</span>;
  }
  const percentage = audit.totals.scorePercentage;
  return (
    <span className={cn('gb-data font-semibold', bandTextClass(percentage))}>
      {percentage === null ? 'N/A' : `${formatScore(percentage)}%`}
    </span>
  );
}

function AssignmentRow({
  assignment,
  team,
  targeted,
  open,
  onToggle,
}: {
  assignment: AuditAssignment;
  /** Every open assignment of this assignment's team, itself included; empty when alone. */
  team: AuditAssignment[];
  targeted: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [reason, setReason] = useState('');

  const cancel = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>(`/audit-assignments/${assignment.id}/cancel`, { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['audit-assignments'] }),
  });

  const others = team.filter((member) => member.id !== assignment.id);

  return (
    <Fragment>
      <tr
        ref={targeted ? scrollIntoViewOnce : undefined}
        onClick={rowToggleProps(onToggle).onClick}
        className={cn('cursor-pointer border-t border-edge-soft', targeted && 'gb-row--target', open && 'gb-row--open')}
      >
        <Td>
          <RowToggle open={open} onClick={onToggle}>
            {assignment.unitName}
          </RowToggle>
          <span className="block text-xs text-ink-3">{AUDIT_TYPE_LABEL[assignment.auditType]}</span>
        </Td>
        <Td>
          <div className="flex flex-wrap items-center gap-2">
            {assignment.auditorName}
            {others.length > 0 && (
              <span
                className="text-xs text-ink-3"
                title={`Same audit as ${others.map((member) => member.auditorName).join(', ')}`}
              >
                + {others.map((member) => member.auditorName).join(', ')}
              </span>
            )}
          </div>
        </Td>
        <Td>{formatDate(assignment.dueAt)}</Td>
        <Td>
          <StatusChip kind="assignment" status={assignment.status} />
        </Td>
      </tr>
      {open && (
        <tr className="gb-row-expand">
          <td colSpan={4} className="space-y-3">
            <AssignmentProgress assignment={assignment} team={team.length > 0 ? team : [assignment]} />
            {/* AU14: one action on the row (open it); cancelling lives in what it opens. */}
            {can('audit_assignment', 'cancel') && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Reason to cancel this assignment">
                  <Input value={reason} onChange={(event) => setReason(event.target.value)} />
                </Field>
                <Button
                  variant="secondary"
                  disabled={reason.trim().length === 0 || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Cancel assignment
                </Button>
              </div>
            )}
            {cancel.error && <ErrorNotice error={cancel.error} />}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * How far an assignment — or its whole team — has got. The audits come from the Unit's
 * list, matched on the assignment they were started against; an auditor who has not
 * started yet is said so rather than left out.
 */
function AssignmentProgress({
  assignment,
  team,
}: {
  assignment: AuditAssignment;
  team: AuditAssignment[];
}) {
  const unitAudits = useQuery({
    queryKey: ['audits', 'unit', assignment.unitId],
    queryFn: () => read<Page<Audit>>(`/audits?unitId=${assignment.unitId}&limit=200`),
    refetchInterval: 30_000,
  });

  if (unitAudits.isLoading) return <Spinner label="Loading progress…" />;
  if (unitAudits.error) return <ErrorNotice error={unitAudits.error} />;

  const ids = new Set(team.map((member) => member.id));
  const audits = (unitAudits.data?.data ?? []).filter(
    (audit) => audit.assignmentId !== null && ids.has(audit.assignmentId),
  );
  const started = new Set(audits.map((audit) => audit.assignmentId));
  const pending = team.filter((member) => !started.has(member.id)).map((member) => member.auditorName);

  if (assignment.groupId && team.length > 1) {
    return (
      <TeamProgress unitId={assignment.unitId} audits={audits} pending={pending} />
    );
  }
  const audit = audits[0];
  return audit ? (
    <AuditProgress auditId={audit.id} />
  ) : (
    <p className="gb-progress-line">
      <b>{assignment.auditorName}</b> has not started this audit on the device yet.
      {assignment.instructions ? ` Instructions: ${assignment.instructions}` : ''}
    </p>
  );
}

interface Draft {
  unitId: string;
  /** In the order picked. The first is the lead; each gets their own assignment. */
  auditorUserIds: string[];
  auditType: CreateAuditAssignmentRequest['auditType'];
  dueAt: string;
  zoneIds: string[];
  instructions: string;
}

const EMPTY_DRAFT: Draft = {
  unitId: '',
  auditorUserIds: [],
  auditType: 'EXTERNAL_5S',
  dueAt: '',
  zoneIds: [],
  instructions: '',
};

/**
 * "New audit" (AU10): the board's button and this page's say the same thing, and what it
 * creates is an assignment — an audit given to one auditor, or to several together (D7).
 *
 * It is a dialog, like New report: closing it with something typed asks before discarding
 * (the `dirty` guard), and the disabled Assign button says what is still missing. Suggested
 * Zones are hints for the auditor's Zone list; the auditor still names the Zones they walk
 * (R-19, R-43(e)).
 */
function NewAuditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Remounts each picker after a pick, so it empties itself for the next name.
  const [pickerKey, setPickerKey] = useState(0);
  // Each opening starts from an empty form; the last one's fields stay while it fades out.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(EMPTY_DRAFT);
  }
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const { unitId } = draft;

  const units = useQuery({
    enabled: open,
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  // Consultants are an independent master list: the assignment grants temporary access to
  // its Unit. Zone Leaders remain Unit-specific, so only leaders of the selected Unit appear.
  const people = useQuery({
    enabled: open,
    queryKey: ['users', 'auditors'],
    queryFn: () => api.get<Page<User>>('/users?limit=200&status=ACTIVE'),
  });
  const members = useQuery({
    enabled: open && Boolean(unitId),
    queryKey: ['memberships', 'unit', unitId],
    queryFn: () =>
      api.get<Page<MembershipDetail>>(`/memberships?unitId=${unitId}&status=ACTIVE&limit=200`),
  });
  const zones = useQuery({
    enabled: open && Boolean(unitId),
    queryKey: ['zones', unitId, 'active'],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?active=true&limit=200`),
  });

  const memberIds = new Set((members.data?.data ?? []).map((membership) => membership.userId));
  const auditors = (people.data?.data ?? []).filter(
    (user) =>
      user.role === 'CONSULTANT' ||
      (user.role === 'ZONE_LEADER' && memberIds.has(user.id)),
  );

  // A Zone Leader of another Unit drops out when the Unit changes; a Consultant stays.
  const eligible = new Set(auditors.map((user) => user.id));
  const picked = draft.auditorUserIds.filter((id) => eligible.has(id));
  const byId = new Map(auditors.map((user) => [user.id, user]));
  // Zones belong to the Unit, so a Unit change drops them.
  const zoneById = new Map((zones.data?.data ?? []).map((zone) => [zone.id, zone]));
  const pickedZones = draft.zoneIds.filter((id) => zoneById.has(id));

  const create = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>('/audit-assignments', {
        unitId,
        auditorUserId: picked[0]!, // the button is disabled until one is picked
        ...(picked.length > 1 ? { coAuditorUserIds: picked.slice(1) } : {}),
        auditType: draft.auditType,
        ...(draft.dueAt ? { dueAt: new Date(draft.dueAt).toISOString() } : {}),
        ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
        ...(pickedZones.length > 0 ? { suggestedZoneIds: pickedZones } : {}),
      } satisfies CreateAuditAssignmentRequest),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['audit-assignments'] }),
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['units'] }),
      ]);
      create.reset();
      onClose();
    },
  });

  const dirty =
    !create.isPending &&
    (unitId !== '' ||
      draft.auditorUserIds.length > 0 ||
      draft.dueAt !== '' ||
      draft.zoneIds.length > 0 ||
      draft.instructions.trim() !== '');
  const missing = !unitId ? 'Choose a Unit.' : picked.length === 0 ? 'Add at least one auditor.' : undefined;
  const zoneLabel = (zone: Zone) =>
    zoneDisplayLabel(zone.code, zone.name) + (zone.zoneLeaderName ? ` · ${zone.zoneLeaderName}` : '');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={dirty}
      wide
      title="New audit"
      description="Give a Unit's audit to one auditor, or to several who walk it together. It appears on their phone."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!missing) create.mutate();
        }}
      >
        <div className="gb-dialog-section grid gap-3 sm:grid-cols-2">
          <Field label="Unit">
            <Combobox
              value={unitId}
              onChange={(id) => set({ unitId: id })}
              options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
              placeholder="Search Units…"
              required
            />
          </Field>

          <Field label="Audit type">
            <Select
              value={draft.auditType}
              onChange={(event) =>
                set({ auditType: event.target.value as CreateAuditAssignmentRequest['auditType'] })
              }
            >
              <option value="EXTERNAL_5S">{AUDIT_TYPE_LABEL.EXTERNAL_5S}</option>
              <option value="CROSS_5S">{AUDIT_TYPE_LABEL.CROSS_5S}</option>
              <option value="WALK_BY">{AUDIT_TYPE_LABEL.WALK_BY}</option>
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Auditors"
              hint={
                picked.length > 1
                  ? `One audit of this Unit by ${picked.length} auditors. Each gets their own assignment and phone; the unit summary combines their Zones.`
                  : 'Any active Consultant, or a Zone Leader of this Unit. Several auditors are one audit together; the first is the lead.'
              }
            >
              <Combobox
                key={`auditor-${pickerKey}`}
                value=""
                onChange={(id) => {
                  if (!id) return;
                  setDraft((current) =>
                    current.auditorUserIds.includes(id)
                      ? current
                      : { ...current, auditorUserIds: [...current.auditorUserIds, id] },
                  );
                  setPickerKey((key) => key + 1);
                }}
                options={auditors
                  .filter((user) => !picked.includes(user.id))
                  .map((user) => ({
                    id: user.id,
                    label: `${user.fullName} (${user.loginId}) — ${user.role === 'CONSULTANT' ? 'Consultant' : 'Zone Leader'}`,
                  }))}
                placeholder={unitId ? (picked.length ? 'Add another auditor…' : 'Search auditors…') : 'Choose a Unit first'}
                disabled={!unitId}
              />
              {picked.length > 0 && (
                <ul className="gb-picked" aria-label="Chosen auditors">
                  {picked.map((id, index) => (
                    <li key={id}>
                      <span>
                        {byId.get(id)?.fullName ?? 'Auditor'}
                        {index === 0 && picked.length > 1 ? <em> lead</em> : null}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${byId.get(id)?.fullName ?? 'auditor'}`}
                        onClick={() =>
                          set({ auditorUserIds: draft.auditorUserIds.filter((value) => value !== id) })
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Suggested Zones"
              hint="Optional. Listed first on the auditor's phone; they can still audit any other Zone."
            >
              <Combobox
                key={`zone-${pickerKey}`}
                value=""
                onChange={(id) => {
                  if (!id) return;
                  setDraft((current) =>
                    current.zoneIds.includes(id) ? current : { ...current, zoneIds: [...current.zoneIds, id] },
                  );
                  setPickerKey((key) => key + 1);
                }}
                options={(zones.data?.data ?? [])
                  .filter((zone) => !pickedZones.includes(zone.id))
                  .map((zone) => ({ id: zone.id, label: zoneLabel(zone) }))}
                keepOrder
                placeholder={unitId ? 'Search this Unit’s Zones…' : 'Choose a Unit first'}
                disabled={!unitId}
              />
              {pickedZones.length > 0 && (
                <ul className="gb-picked" aria-label="Suggested Zones">
                  {pickedZones.map((id) => {
                    const zone = zoneById.get(id)!;
                    return (
                      <li key={id}>
                        <span>{zoneDisplayLabel(zone.code, zone.name)}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${zoneDisplayLabel(zone.code, zone.name)}`}
                          onClick={() => set({ zoneIds: draft.zoneIds.filter((value) => value !== id) })}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Field>
          </div>

          <Field label="Due" hint="Optional">
            <Input type="date" value={draft.dueAt} onChange={(event) => set({ dueAt: event.target.value })} />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Instructions" hint="Optional. The auditor reads these on the phone.">
              <textarea
                className="gb-input"
                rows={3}
                maxLength={2000}
                value={draft.instructions}
                onChange={(event) => set({ instructions: event.target.value })}
              />
            </Field>
          </div>

          {create.error ? (
            <div className="sm:col-span-2">
              <ErrorNotice error={create.error} />
            </div>
          ) : null}
        </div>

        <DialogActions reason={missing}>
          <CancelButton disabled={create.isPending} />
          <Button type="submit" disabled={create.isPending || missing !== undefined}>
            {create.isPending
              ? 'Assigning…'
              : picked.length > 1
                ? `Assign to ${picked.length} auditors`
                : 'Assign audit'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Cancel asks first when something is typed, like Escape and ✕ (the dialog's own guard). */
function CancelButton({ disabled }: { disabled: boolean }) {
  const close = useDialogClose();
  return (
    <Button type="button" variant="secondary" onClick={close} disabled={disabled}>
      Cancel
    </Button>
  );
}

/** Re-exported for the detail panel, which renders the same problem documents. */
export { ApiError };
