import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Audit,
  AuditAssignment,
  AuditStatus,
  CreateAuditAssignmentRequest,
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
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showActiveOnly, setShowActiveOnly] = useState(true);

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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={isConsultant ? 'My audits' : 'Audits'}
          description={
            isConsultant
              ? 'Every audit you conducted, newest first. Read-only — the official report is a Super Admin deliverable (N5).'
              : 'The live board: assigned, ready, in progress and paused audits across the Units you can see.'
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

        {audits.data && audits.data.data.length === 0 && (
          <p className="px-4 py-6 text-sm text-ink-3">
            {showActiveOnly ? 'No audits are running right now.' : 'No audits yet.'}
          </p>
        )}

        {audits.data && audits.data.data.length > 0 && (
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
              {audits.data.data.map((audit) => (
                <tr key={audit.id} className="border-t border-edge-soft">
                  <Td>{audit.unitName}</Td>
                  <Td>{AUDIT_TYPE_LABELS[audit.auditType]}</Td>
                  <Td>{audit.auditorName}</Td>
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
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && <AuditDetailPanel auditId={selected} onClose={() => setSelected(null)} />}

      {!isConsultant && assignments.data && assignments.data.data.length > 0 && (
        <Card>
          <CardHeader
            title="Open assignments"
            description="Assigned work that has not been completed. Revoking a Unit membership cancels these rather than deleting them (AA-1)."
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
              {assignments.data.data.map((assignment) => (
                <AssignmentRow key={assignment.id} assignment={assignment} />
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
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

function AssignmentRow({ assignment }: { assignment: AuditAssignment }) {
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [reason, setReason] = useState('');

  const cancel = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>(`/audit-assignments/${assignment.id}/cancel`, { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['audit-assignments'] }),
  });

  return (
    <tr className="border-t border-edge-soft">
      <Td>{assignment.unitName}</Td>
      <Td>{assignment.auditorName}</Td>
      <Td>{AUDIT_TYPE_LABELS[assignment.auditType]}</Td>
      <Td>{assignment.dueAt ? new Date(assignment.dueAt).toLocaleDateString() : '—'}</Td>
      <Td>
        <Badge tone="neutral">{assignment.status}</Badge>
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
  );
}

function CreateAssignmentForm({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient();
  const [unitId, setUnitId] = useState('');
  const [auditorUserId, setAuditorUserId] = useState('');
  const [auditType, setAuditType] = useState<CreateAuditAssignmentRequest['auditType']>(
    'EXTERNAL_5S',
  );
  const [dueAt, setDueAt] = useState('');
  const [instructions, setInstructions] = useState('');

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  // Only members of the chosen Unit may be assigned (AA-1); the server refuses anyone
  // else, and offering them here would be an invitation to a 422.
  const members = useQuery({
    enabled: Boolean(unitId),
    queryKey: ['users', unitId],
    queryFn: () => api.get<Page<User>>(`/users?unitId=${unitId}&limit=200`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>('/audit-assignments', {
        unitId,
        auditorUserId,
        auditType,
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audit-assignments'] });
      onCreated();
    },
  });

  const auditors = (members.data?.data ?? []).filter(
    (user) => user.role === 'CONSULTANT' || user.role === 'ZONE_LEADER',
  );

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
          label="Auditor"
          hint="Consultants and Zone Leaders with an active membership in that Unit"
        >
          <Select
            value={auditorUserId}
            onChange={(event) => setAuditorUserId(event.target.value)}
            required
            disabled={!unitId}
          >
            <option value="">Choose an auditor…</option>
            {auditors.map((user) => (
              <option key={user.id} value={user.id}>
                {user.fullName} ({user.loginId})
              </option>
            ))}
          </Select>
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

      <Button type="submit" disabled={create.isPending || !unitId || !auditorUserId}>
        {create.isPending ? 'Assigning…' : 'Assign'}
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
