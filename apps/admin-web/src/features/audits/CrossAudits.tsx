import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrossAuditor, CrossAuditRound, CrossAuditZoneState, Page, Zone } from '@audit5s/contracts';
import { formatDate, istDateKey, uuidv7, zoneDisplayLabel } from '@audit5s/domain';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNotice, Field, Input, Segmented, Select, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * Cross audits on the web (R-56), as on the phone: one call of any number of Zones — or all —
 * is one cross-zonal audit, listed on the Active, Completed and Assigned boards; opening it
 * shows that board's Zones, and the Coordinator moves its deadline or completes it, with a
 * remark when a Zone was left. R-73: each Zone is given to one of the Unit's Zone Leaders /
 * Auditors, who alone is told and alone sees it; the Coordinator may give it to someone else.
 */

type Board = 'ACTIVE' | 'DONE' | 'ASSIGNED';

const BOARDS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DONE', label: 'Completed' },
  { value: 'ASSIGNED', label: 'Assigned' },
] as const;

const BOARD_STATE: Record<Board, CrossAuditZoneState> = { ACTIVE: 'IN_PROGRESS', DONE: 'COMPLETED', ASSIGNED: 'NOT_STARTED' };

const day = (dueOn: string) => formatDate(`${dueOn}T12:00:00+05:30`);
const today = () => istDateKey(Date.now()) ?? '';

function closed(round: CrossAuditRound): boolean {
  return round.completedAt !== null || round.zones.every((zone) => zone.state === 'COMPLETED');
}

/** The Unit's Zone Leaders / Auditors, who a Zone of a cross audit may be given to (R-73). */
function useCrossAuditors(unitId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cross-auditors', unitId],
    queryFn: () => api.get<CrossAuditor[]>(`/units/${unitId}/cross-auditors`),
    enabled: enabled && unitId !== '',
  });
}

/** Tick the Zones — or Select all — give each to someone, and the day it is due (R-73). */
export function CallCrossAuditDialog({ unitId, open, onClose }: { unitId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?limit=200`),
    enabled: open && unitId !== '',
  });
  const list = [...(zones.data?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const people = useCrossAuditors(unitId, open);
  const [selected, setSelected] = useState<string[]>([]);
  const [auditorOf, setAuditorOf] = useState<Record<string, string>>({});
  const [dueOn, setDueOn] = useState(() => istDateKey(Date.now() + 7 * 86_400_000) ?? '');
  useEffect(() => {
    if (open) {
      setSelected([]);
      setAuditorOf({});
    }
  }, [open]);
  const all = list.length > 0 && selected.length === list.length;
  const unassigned = selected.filter((zoneId) => !auditorOf[zoneId]).length;
  const call = useMutation({
    mutationFn: () =>
      api.post(
        `/units/${unitId}/cross-audit`,
        { assignments: selected.map((zoneId) => ({ zoneId, auditorUserId: auditorOf[zoneId]! })), dueOn },
        uuidv7(),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cross-audits', unitId] });
      onClose();
    },
  });

  return (
    <ConfirmDialog
      open={open}
      title="Start a cross audit"
      tone="primary"
      confirmLabel={selected.length > 0 ? `Notify auditors · ${selected.length} Zone${selected.length === 1 ? '' : 's'}` : 'Notify auditors'}
      pending={call.isPending}
      disabled={selected.length === 0 || unassigned > 0 || !dueOn}
      error={call.error}
      onConfirm={() => call.mutate()}
      onCancel={onClose}
    >
      <div className="flex items-center justify-between gap-3 border-b border-edge-soft pb-2">
        <span className="gb-label">Zones</span>
        <label className="flex items-center gap-2 text-sm font-bold">
          Select all
          <input
            type="checkbox"
            checked={all}
            disabled={list.length === 0}
            onChange={(event) => setSelected(event.target.checked ? list.map((zone) => zone.id) : [])}
          />
        </label>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto py-2">
        {zones.isPending ? <p className="text-sm text-ink-2">Loading Zones…</p> : null}
        {zones.data && list.length === 0 ? <p className="text-sm text-ink-2">This Unit has no Zones yet.</p> : null}
        {list.map((zone) => (
          <div key={zone.id} className="py-1">
            <label className="flex items-center justify-between gap-3 text-sm">
              {zoneDisplayLabel(zone.code, zone.name)}
              <input
                type="checkbox"
                checked={selected.includes(zone.id)}
                onChange={(event) =>
                  setSelected(list.map((one) => one.id).filter((id) => (id === zone.id ? event.target.checked : selected.includes(id))))
                }
              />
            </label>
            {selected.includes(zone.id) ? (
              <Select
                aria-label={`Who audits ${zoneDisplayLabel(zone.code, zone.name)}`}
                className="mt-1"
                value={auditorOf[zone.id] ?? ''}
                onChange={(event) => setAuditorOf({ ...auditorOf, [zone.id]: event.target.value })}
              >
                <option value="">Who audits this Zone?</option>
                {(people.data ?? []).map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.fullName}
                    {person.loginId ? ` (${person.loginId})` : ''}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        ))}
        {people.data && people.data.length === 0 ? (
          <p className="text-sm text-ink-2">This Unit has no Zone Leaders / Auditors yet. Add them from the Auditor list.</p>
        ) : null}
      </div>
      <ErrorNotice error={people.error} />
      <Field label="Due by">
        <Input type="date" value={dueOn} min={today()} onChange={(event) => setDueOn(event.target.value)} />
      </Field>
      <p className="mt-3">
        Each person you chose gets one notification asking them to audit their Zones
        {dueOn ? ` by ${day(dueOn)}` : ''}. Only they see those Zones on their list, marked overdue after that day, until the Zone
        is audited.{unassigned > 0 ? ` Choose who audits ${unassigned === 1 ? 'the last Zone' : `${unassigned} Zones`}.` : ''}
      </p>
    </ConfirmDialog>
  );
}

/** The Unit's cross-zonal audits, by board, each opening on that board's Zones. */
export function CrossAuditsCard({ unitId, mayManage }: { unitId: string; mayManage: boolean }) {
  const [board, setBoard] = useState<Board>('ACTIVE');
  const [calling, setCalling] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const rounds = useQuery({
    queryKey: ['cross-audits', unitId],
    queryFn: () => api.get<CrossAuditRound[]>(`/units/${unitId}/cross-audits`),
    refetchInterval: 30_000,
  });
  // An open cross audit is on every board; a finished one only on Completed.
  const shown = (rounds.data ?? []).filter((round) => board === 'DONE' || !closed(round));

  return (
    <Card>
      <CardHeader
        title="Cross-zonal audits"
        description="One card per cross audit you called. Open one for its Zones on this board — under way, done, or not started."
        action={mayManage ? <Button onClick={() => setCalling(true)}>Start a cross audit</Button> : undefined}
      />
      <div className="p-4 pb-0">
        <Segmented label="Board" options={BOARDS} value={board} onChange={setBoard} />
      </div>
      {rounds.error ? (
        <div className="p-4">
          <ErrorNotice error={rounds.error} />
        </div>
      ) : null}
      {rounds.data && shown.length === 0 ? <EmptyState title="No cross audit on this board." /> : null}
      <div className="space-y-3 p-4">
        {shown.map((round) => (
          <RoundCard
            key={round.id}
            round={round}
            board={board}
            open={opened === round.id}
            onToggle={() => setOpened(opened === round.id ? null : round.id)}
            mayManage={mayManage}
          />
        ))}
      </div>
      {mayManage ? <CallCrossAuditDialog unitId={unitId} open={calling} onClose={() => setCalling(false)} /> : null}
    </Card>
  );
}

function RoundCard({
  round,
  board,
  open,
  onToggle,
  mayManage,
}: {
  round: CrossAuditRound;
  board: Board;
  open: boolean;
  onToggle: () => void;
  mayManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [dueOn, setDueOn] = useState(round.dueOn);
  const [completing, setCompleting] = useState(false);
  const [remark, setRemark] = useState('');
  const count = (state: CrossAuditZoneState) => round.zones.filter((zone) => zone.state === state).length;
  const left = round.zones.length - count('COMPLETED');
  const late = !closed(round) && round.dueOn < today();
  const zones = round.zones.filter((zone) => zone.state === BOARD_STATE[board]);
  const path = `/units/${round.unitId}/cross-audits/${round.id}`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['cross-audits', round.unitId] });
  const extend = useMutation({ mutationFn: () => api.patch(path, { dueOn }), onSuccess: refresh });
  const complete = useMutation({
    mutationFn: () => api.post(`${path}/complete`, remark.trim() ? { remark: remark.trim() } : {}, uuidv7()),
    onSuccess: async () => {
      await refresh();
      setCompleting(false);
    },
  });
  const manage = mayManage && round.completedAt === null;
  const people = useCrossAuditors(round.unitId, open && manage);
  const reassign = useMutation({
    mutationFn: ({ zoneId, auditorUserId }: { zoneId: string; auditorUserId: string }) =>
      api.put(`${path}/zones/${zoneId}/assignee`, { auditorUserId }),
    onSuccess: refresh,
  });

  return (
    <div className={late ? 'gb-panel border-l-4 border-l-crit' : 'gb-panel'}>
      <button type="button" className="flex w-full cursor-pointer flex-col gap-1 p-3 text-left" aria-expanded={open} onClick={onToggle}>
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold uppercase">
            Cross-zonal audit · {round.zones.length} Zone{round.zones.length === 1 ? '' : 's'}
          </span>
          {round.completedAt ? <Badge>Completed</Badge> : late ? <Badge tone="bad">Overdue</Badge> : closed(round) ? <Badge tone="good">All done</Badge> : null}
        </span>
        <span className="text-sm text-ink-2">
          Called {formatDate(round.createdAt)} by {round.calledBy} · {late ? 'Overdue since' : 'Due'} {day(round.dueOn)}
        </span>
        <span className="gb-data text-sm">
          {count('NOT_STARTED')} not started · {count('IN_PROGRESS')} under way · {count('COMPLETED')} done
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-edge-soft p-3">
          {round.completedAt ? (
            <p className="text-sm">
              Completed {formatDate(round.completedAt)} by {round.completedBy ?? 'the Coordinator'}.
              {round.completionRemark ? ` Remark: ${round.completionRemark}` : ''}
            </p>
          ) : null}
          {zones.length === 0 ? (
            <p className="text-sm text-ink-2">No Zone of this cross audit is on this board.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Zone</Th>
                  <Th>Assigned to</Th>
                  <Th>Auditor</Th>
                </tr>
              </thead>
              <tbody>
                {zones.map((zone) => (
                  <tr key={zone.zoneId}>
                    <Td>{zoneDisplayLabel(zone.zoneCode, zone.zoneName)}</Td>
                    <Td>
                      {manage && zone.state === 'NOT_STARTED' && people.data ? (
                        <Select
                          aria-label={`Who audits ${zoneDisplayLabel(zone.zoneCode, zone.zoneName)}`}
                          value={zone.assigneeUserId ?? ''}
                          disabled={reassign.isPending}
                          onChange={(event) => reassign.mutate({ zoneId: zone.zoneId, auditorUserId: event.target.value })}
                        >
                          {zone.assigneeUserId ? null : <option value="">Every Zone Leader</option>}
                          {people.data.map((person) => (
                            <option key={person.userId} value={person.userId}>
                              {person.fullName}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        (zone.assigneeName ?? 'Every Zone Leader')
                      )}
                    </Td>
                    <Td>{zone.auditorName ?? 'Nobody has started it'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {manage ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Deadline">
                <Input type="date" value={dueOn} min={today()} onChange={(event) => setDueOn(event.target.value)} />
              </Field>
              <Button variant="secondary" disabled={!dueOn || dueOn === round.dueOn || extend.isPending} onClick={() => extend.mutate()}>
                {extend.isPending ? 'Saving…' : 'Extend deadline'}
              </Button>
              <Button onClick={() => setCompleting(true)}>Complete cross audit</Button>
            </div>
          ) : null}
          <ErrorNotice error={extend.error ?? reassign.error} />
        </div>
      ) : null}
      <ConfirmDialog
        open={completing}
        title="Complete this cross audit?"
        tone="primary"
        confirmLabel="Complete"
        pending={complete.isPending}
        disabled={left > 0 && !remark.trim()}
        error={complete.error}
        onConfirm={() => complete.mutate()}
        onCancel={() => setCompleting(false)}
      >
        {left > 0 ? (
          <Field label={`Why complete it with ${left} Zone${left === 1 ? '' : 's'} not audited?`}>
            <textarea className="gb-input" rows={3} maxLength={2000} value={remark} onChange={(event) => setRemark(event.target.value)} />
          </Field>
        ) : (
          <p>Every Zone is audited.</p>
        )}
        <p className="mt-3">No Zone Leader is asked to audit its Zones any more. The remark is kept with it.</p>
      </ConfirmDialog>
    </div>
  );
}
