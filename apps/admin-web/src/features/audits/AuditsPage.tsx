import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Audit,
  AuditAssignment,
  AuditStatus,
  CreateAuditAssignmentRequest,
  MembershipDetail,
  Page,
  Unit,
  User,
} from '@audit5s/contracts';
import { bandTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { ApiError, api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Combobox,
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
import { AuditDetailPanel } from './AuditDetailPanel';
import { AuditProgress, TeamProgress } from './AuditProgress';

/** `/audits?audit=…` or `?assignment=…` — where a notification sends someone. */
export interface AuditsSearch {
  audit?: string;
  assignment?: string;
}

/**
 * The live audit board (§2.1 step 10) and assignment creation.
 *
 * Everything on this page is scope-filtered by the server: `GET /audits` returns whatever
 * the actor's resolver admits, so a Coordinator sees their Unit's audits and a Consultant
 * their own read-only history — from the same component, with no client-side filter over a
 * wider set that could be widened by a bug.
 */
export function AuditsPage() {
  const { scope, can } = useSession();
  const search = useSearch({ strict: false }) as AuditsSearch;
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // A deep link may point at a finished audit, which the active-only board would hide.
  const [showActiveOnly, setShowActiveOnly] = useState(!search.audit);
  const [expanded, setExpanded] = useState<string | null>(search.audit ?? null);
  const [expandedAssignment, setExpandedAssignment] = useState<string | null>(
    search.assignment ?? null,
  );

  // Arriving from a second notification while already on this page re-targets it.
  useEffect(() => {
    if (search.audit) {
      setShowActiveOnly(false);
      setExpanded(search.audit);
    }
  }, [search.audit]);
  useEffect(() => {
    if (search.assignment) setExpandedAssignment(search.assignment);
  }, [search.assignment]);

  const audits = useQuery({
    queryKey: ['audits', showActiveOnly],
    queryFn: () =>
      api.get<Page<Audit>>(`/audits?limit=200${showActiveOnly ? '&active=true' : ''}`),
    // The board is a live view of what is happening in the plants right now.
    refetchInterval: showActiveOnly ? 30_000 : false,
  });

  const assignments = useQuery({
    queryKey: ['audit-assignments'],
    queryFn: () => api.get<Page<AuditAssignment>>('/audit-assignments?open=true&limit=200'),
  });

  const isConsultant = scope?.role === 'CONSULTANT';

  // Newest first. The server already orders so, but a board read top-down is the whole
  // point, so it is stated here rather than trusted.
  const auditRows = useMemo(
    () => [...(audits.data?.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={isConsultant ? 'My audits' : 'Audits'}
          description={
            isConsultant
              ? 'Every audit you conducted, newest first. Read-only — the official report is a Super Admin deliverable (N5).'
              : 'Newest first. Click a Unit to see its progress Zone by Zone; a team audit shows every auditor’s share.'
          }
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setShowActiveOnly((value) => !value)}>
                {showActiveOnly ? 'Show all' : 'Show active only'}
              </Button>
              {can('audit_assignment', 'create') && (
                <Button onClick={() => setAssigning((open) => !open)}>
                  {assigning ? 'Cancel' : 'New assignment'}
                </Button>
              )}
            </div>
          }
        />

        {assigning && <CreateAssignmentForm onCreated={() => setAssigning(false)} />}

        {audits.isLoading && <Spinner />}
        {audits.error && (
          <div className="p-4">
            <ErrorNotice error={audits.error} />
          </div>
        )}

        {audits.data && auditRows.length === 0 && (
          <p className="px-4 py-6 text-sm text-ink-3">
            {showActiveOnly ? 'No audits are running right now.' : 'No audits yet.'}
          </p>
        )}

        {auditRows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Type</Th>
                <Th>Auditor</Th>
                <Th>Status</Th>
                <Th>Score</Th>
                <Th>Updated</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((audit) => {
                const open = expanded === audit.id;
                const size = teamSize(audit.assignmentGroupId);
                const team = audit.assignmentGroupId ? teams.get(audit.assignmentGroupId) : undefined;
                return (
                  <Fragment key={audit.id}>
                    <tr
                      ref={audit.id === search.audit ? scrollIntoViewOnce : undefined}
                      className={cn(
                        'border-t border-edge-soft',
                        audit.id === search.audit && 'gb-row--target',
                        open && 'gb-row--open',
                      )}
                    >
                      <Td>
                        <RowToggle open={open} onClick={() => setExpanded(open ? null : audit.id)}>
                          {audit.unitName}
                        </RowToggle>
                      </Td>
                      <Td>{AUDIT_TYPE_LABELS[audit.auditType]}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          {audit.auditorName}
                          {size > 1 && <Badge tone="neutral">team of {size}</Badge>}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Badge tone={STATUS_TONE[audit.status]}>{STATUS_LABELS[audit.status]}</Badge>
                          <LocationFlag audit={audit} />
                        </div>
                      </Td>
                      <Td>
                        <ScoreCell audit={audit} />
                      </Td>
                      <Td className="text-ink-3">
                        {new Date(audit.updatedAt).toLocaleString()}
                      </Td>
                      <Td>
                        <Button
                          variant="secondary"
                          onClick={() => setSelected(selected === audit.id ? null : audit.id)}
                        >
                          {selected === audit.id ? 'Hide' : 'Open'}
                        </Button>
                      </Td>
                    </tr>
                    {open && (
                      <tr className="gb-row-expand">
                        <td colSpan={7}>
                          {audit.assignmentGroupId && size > 1 ? (
                            <TeamProgress
                              unitId={audit.unitId}
                              audits={team?.audits ?? [audit]}
                              pending={pendingAuditors(team)}
                            />
                          ) : (
                            <AuditProgress auditId={audit.id} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && <AuditDetailPanel auditId={selected} onClose={() => setSelected(null)} />}

      {!isConsultant && assignmentRows.length > 0 && (
        <Card>
          <CardHeader
            title="Open assignments"
            description="Assigned work not yet completed, newest first. Click a Unit to see how far its auditors have got. Revoking a Unit membership cancels these rather than deleting them (AA-1)."
          />
          <Table>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Auditor</Th>
                <Th>Type</Th>
                <Th>Due</Th>
                <Th>Status</Th>
                <Th> </Th>
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
  requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
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
 * A score cell. `null` prints `N/A`, never `0%` (D4) — a Zone with nothing applicable has
 * no percentage, and showing zero would report a failure that did not happen.
 */
/**
 * §12.9's flag, surfaced — and deliberately not turned into a judgement.
 *
 * > surfaces flagged audits to Super Admin and marks them on the report; **never blocks an
 * > audit** on location.
 *
 * The wording matters as much as the badge. §12.9 is explicit that this system makes no
 * anti-spoofing claim, so the tooltip says what was observed — the distance, or that there
 * was no reading — and stops there. "Suspicious" is the column's word for *look at this*,
 * not for *this person did something*, and the copy is written so a reviewer reading it
 * quickly does not come away with the stronger meaning.
 */
function LocationFlag({ audit }: { audit: Audit }) {
  if (!audit.locationSuspicious) return null;

  const distance =
    audit.startDistanceFromUnitM === null
      ? null
      : `${Math.round(audit.startDistanceFromUnitM).toLocaleString()} m from the Unit`;

  const reason =
    audit.startLatitude === null
      ? 'No location was recorded when this audit started.'
      : audit.startLocationIsMocked
        ? `The device reported a mock location provider${distance ? ` (${distance})` : ''}.`
        : (distance ?? 'The Unit has no coordinates to measure against.');

  return (
    <span
      title={`${reason} Location is supporting evidence for a reviewer — it is recorded, never used to block an audit.`}
      className="cursor-help"
    >
      <Badge tone="warn">check location</Badge>
    </span>
  );
}

function ScoreCell({ audit }: { audit: Audit }) {
  if (!audit.scored) {
    return <span className="text-ink-3">Not scored</span>;
  }
  if (audit.status !== 'COMPLETED' && audit.totals.maxScore === 0) {
    return <span className="text-ink-3">—</span>;
  }
  const percentage = audit.totals.scorePercentage;
  return (
    <span className={cn('font-semibold', bandTextClass(percentage))}>
      {percentage === null ? 'N/A' : `${percentage.toFixed(1)}%`}
      <span className="ml-2 font-normal text-ink-3">
        {audit.totals.rawScore} / {audit.totals.maxScore}
      </span>
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
        className={cn('border-t border-edge-soft', targeted && 'gb-row--target', open && 'gb-row--open')}
      >
        <Td>
          <RowToggle open={open} onClick={onToggle}>
            {assignment.unitName}
          </RowToggle>
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
        <Td>{AUDIT_TYPE_LABELS[assignment.auditType]}</Td>
        <Td>{assignment.dueAt ? new Date(assignment.dueAt).toLocaleDateString() : '—'}</Td>
        <Td>
          <Badge tone={assignment.status === 'IN_PROGRESS' ? 'warn' : 'neutral'}>
            {assignment.status.replace(/_/g, ' ').toLowerCase()}
          </Badge>
        </Td>
        <Td>
          {can('audit_assignment', 'cancel') && (
            <div className="flex gap-2">
              <Input
                placeholder="Reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={reason.trim().length === 0 || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel
              </Button>
            </div>
          )}
          {cancel.error && <ErrorNotice error={cancel.error} />}
        </Td>
      </tr>
      {open && (
        <tr className="gb-row-expand">
          <td colSpan={6}>
            <AssignmentProgress assignment={assignment} team={team.length > 0 ? team : [assignment]} />
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
    queryFn: () => api.get<Page<Audit>>(`/audits?unitId=${assignment.unitId}&limit=200`),
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

function CreateAssignmentForm({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient();
  const [unitId, setUnitId] = useState('');
  /** In the order picked. The first is the lead; each gets their own assignment. */
  const [auditorUserIds, setAuditorUserIds] = useState<string[]>([]);
  // Remounts the picker after each pick, so it empties itself for the next name.
  const [pickerKey, setPickerKey] = useState(0);
  const [auditType, setAuditType] = useState<CreateAuditAssignmentRequest['auditType']>(
    'EXTERNAL_5S',
  );
  const [dueAt, setDueAt] = useState('');
  const [instructions, setInstructions] = useState('');

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  // Consultants are an independent master list: the assignment grants temporary access to
  // its Unit. Zone Leaders remain Unit-specific, so only leaders of the selected Unit appear.
  const people = useQuery({
    queryKey: ['users', 'auditors'],
    queryFn: () => api.get<Page<User>>('/users?limit=200&status=ACTIVE'),
  });
  const members = useQuery({
    enabled: Boolean(unitId),
    queryKey: ['memberships', 'unit', unitId],
    queryFn: () =>
      api.get<Page<MembershipDetail>>(`/memberships?unitId=${unitId}&status=ACTIVE&limit=200`),
  });

  const memberIds = new Set((members.data?.data ?? []).map((membership) => membership.userId));
  const auditors = (people.data?.data ?? []).filter(
    (user) =>
      user.role === 'CONSULTANT' ||
      (user.role === 'ZONE_LEADER' && memberIds.has(user.id)),
  );

  // A Zone Leader of another Unit drops out when the Unit changes; a Consultant stays.
  const eligible = new Set(auditors.map((user) => user.id));
  const picked = auditorUserIds.filter((id) => eligible.has(id));
  const byId = new Map(auditors.map((user) => [user.id, user]));

  const create = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>('/audit-assignments', {
        unitId,
        auditorUserId: picked[0],
        ...(picked.length > 1 ? { coAuditorUserIds: picked.slice(1) } : {}),
        auditType,
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['audit-assignments'] }),
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['units'] }),
      ]);
      onCreated();
    },
  });

  return (
    <form
      className="space-y-3 border-b border-edge-soft p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Unit">
          <Combobox
            value={unitId}
            onChange={setUnitId}
            options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
            placeholder="Search Units…"
            required
          />
        </Field>

        <Field
          label="Auditors"
          hint={
            picked.length > 1
              ? `One audit of this Unit by ${picked.length} auditors. Each gets their own assignment and phone; the unit summary combines their Zones.`
              : 'Add one or more — any active Consultant, or a Zone Leader of this Unit. Several auditors are one audit together.'
          }
        >
          <Combobox
            key={pickerKey}
            value=""
            onChange={(id) => {
              if (!id) return;
              setAuditorUserIds((current) => (current.includes(id) ? current : [...current, id]));
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
                    onClick={() => setAuditorUserIds((current) => current.filter((value) => value !== id))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>

        <Field label="Audit type">
          <Select
            value={auditType}
            onChange={(event) =>
              setAuditType(event.target.value as CreateAuditAssignmentRequest['auditType'])
            }
          >
            <option value="EXTERNAL_5S">External 5S audit</option>
            <option value="CROSS_5S">Cross audit</option>
            <option value="WALK_BY">Walk-by</option>
          </Select>
        </Field>

        <Field label="Due" hint="Optional">
          <Input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </Field>
      </div>

      <Field label="Instructions" hint="Optional; the auditor sees these on the device">
        <Input value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </Field>

      {create.error && <ErrorNotice error={create.error} />}

      <Button type="submit" disabled={create.isPending || !unitId || picked.length === 0}>
        {create.isPending
          ? 'Assigning…'
          : picked.length > 1
            ? `Assign to ${picked.length} auditors`
            : 'Assign'}
      </Button>
    </form>
  );
}

export const AUDIT_TYPE_LABELS: Record<string, string> = {
  EXTERNAL_5S: 'External 5S',
  CROSS_5S: 'Cross audit',
  WALK_BY: 'Walk-by',
};

export const STATUS_LABELS: Record<AuditStatus, string> = {
  ASSIGNED: 'Assigned',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  CORRECTIVE_ACTION_OPEN: 'Corrective actions open',
  PARTIALLY_CLOSED: 'Partially closed',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

const STATUS_TONE: Record<AuditStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  ASSIGNED: 'neutral',
  READY: 'neutral',
  IN_PROGRESS: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'good',
  CORRECTIVE_ACTION_OPEN: 'warn',
  PARTIALLY_CLOSED: 'warn',
  CLOSED: 'good',
  CANCELLED: 'bad',
};

/** Re-exported for the detail panel, which renders the same problem documents. */
export { ApiError };
