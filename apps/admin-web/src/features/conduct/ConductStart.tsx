import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Audit, AuditType, Page } from '@audit5s/contracts';
import { formatDate, formatDateTime, istDateKey, uuidv7, zoneDisplayLabel } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import { Button, Card, CardHeader, ConfirmDialog, EmptyState, Combobox, ErrorNotice, Field, Input, Select, StatusChip, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api';
import { useWebDevice } from '@/lib/device';
import { uploadEvidence } from '@/lib/evidence';
import { LiveCapture } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { AUDIT_TYPE_LABEL, startableTypes, useCatalogue } from './shared';

/**
 * Run an audit on the web (R-51): the phone's `audit-start.tsx` at a desk, with the same
 * rule (owner, 2026-10-12) — the selfie, then the Zone, and only the questions that are real
 * choices on the way: the Unit when there are several, the kind when the person may run more
 * than one (a Coordinator starts a 5S audit only), and, when an audit of the Unit is already
 * open, whether to carry on with it. The selfie is a live webcam photograph (§7.1, §12.10).
 * The audit is created as this browser's once the selfie is taken, then started.
 */
export function ConductStartPage() {
  useDocumentTitle('Run an audit');
  const { user, can, scope } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const device = useWebDevice();
  const catalogue = useCatalogue();
  const types: AuditType[] = scope?.role === 'COORDINATOR' ? ['EXTERNAL_5S'] : startableTypes(can);
  const [picked, setPicked] = useState<AuditType | null>(null);
  const [unitId, setUnitId] = useState('');
  const [another, setAnother] = useState(false);
  const [calling, setCalling] = useState(false);
  const [crossZoneId, setCrossZoneId] = useState('');
  // The day it is due (owner, 2026-10-14): a week out unless the Coordinator moves it.
  const [crossDueOn, setCrossDueOn] = useState(() => istDateKey(Date.now() + 7 * 86_400_000) ?? '');
  const auditType = types.length === 1 ? types[0]! : picked;

  const open = useQuery({
    queryKey: ['conduct', 'mine', user?.id],
    queryFn: () => api.get<Page<Audit>>(`/audits?auditorId=${user!.id}&active=true&limit=50`),
    enabled: Boolean(user),
  });

  const units = catalogue.data?.units ?? [];
  const unit = unitId || (units.length === 1 ? units[0]!.id : '');

  const start = useMutation({
    mutationFn: async (photo: Blob) => {
      const client = device.client!;
      const auditId = uuidv7();
      await client.post('/audits', { id: auditId, auditType, unitId: unit, clientCreatedAt: new Date().toISOString() }, auditId);
      await uploadEvidence(photo, { kind: 'AUDITOR_SELFIE', auditId, isLiveCapture: true }, client);
      await client.post(`/audits/${auditId}/start`, { startedAt: new Date().toISOString() }, uuidv7());
      return auditId;
    },
    onSuccess: async (auditId) => {
      await queryClient.invalidateQueries({ queryKey: ['conduct'] });
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
      void navigate({ to: '/conduct/$auditId', params: { auditId } });
    },
  });

  // §2.6: a Coordinator calls a cross audit of one Zone; every Zone Leader of the Unit is told.
  const unitZones = catalogue.data?.zones.filter((zone) => zone.unitId === unit) ?? [];
  const crossZone = unitZones.find((zone) => zone.id === crossZoneId);
  const callCross = useMutation({
    mutationFn: () => api.post(`/units/${unit}/cross-audit`, { zoneId: crossZoneId, dueOn: crossDueOn }, uuidv7()),
    onSuccess: () => setCalling(false),
  });

  if (types.length === 0) return <EmptyState title="Your role does not conduct audits." />;
  const openAudits = open.data?.data ?? [];
  const openHere = openAudits.find((audit) => audit.unitId === unit);
  const toAudit = (auditId: string) => void navigate({ to: '/conduct/$auditId', params: { auditId } });

  return (
    <div className="space-y-4">
      {/* The way back into an audit left open here or on a phone; absent when there is none. */}
      {openAudits.length > 0 ? (
        <Card>
          <CardHeader title="Your open audits" />
          <Table>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {openAudits.map((audit) => (
                <tr key={audit.id}>
                  <Td>{audit.unitName}</Td>
                  <Td>{AUDIT_TYPE_LABEL[audit.auditType]}</Td>
                  <Td>
                    <StatusChip kind="audit" status={audit.status} />
                  </Td>
                  <Td className="gb-data">{audit.startedAt ? formatDateTime(audit.startedAt) : '—'}</Td>
                  <Td className="text-right">
                    <Button variant="secondary" onClick={() => toAudit(audit.id)}>
                      {audit.status === 'PAUSED' ? 'Resume' : 'Continue'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {unit && can('unit', 'call_cross_audit') ? (
        <Card>
          <CardHeader
            title="Cross audit"
            description="Pick a Zone and the date it is due. Every Zone Leader of the Unit is notified to audit it."
            action={
              <Button variant="secondary" onClick={() => setCalling(true)}>
                Call a cross audit
              </Button>
            }
          />
          {callCross.isSuccess ? (
            <p className="gb-notice m-4" role="status">
              The Zone Leaders have been notified{crossZone ? ` to audit ${zoneDisplayLabel(crossZone.code, crossZone.name)}` : ''}.
            </p>
          ) : null}
        </Card>
      ) : null}
      <ConfirmDialog
        open={calling}
        title="Call a cross audit?"
        tone="primary"
        confirmLabel="Notify Zone Leaders"
        pending={callCross.isPending}
        disabled={!crossZone || !crossDueOn}
        error={callCross.error}
        onConfirm={() => callCross.mutate()}
        onCancel={() => setCalling(false)}
      >
        <Field label="Zone">
          <Select value={crossZoneId} onChange={(event) => setCrossZoneId(event.target.value)}>
            <option value="">Choose a Zone…</option>
            {unitZones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zoneDisplayLabel(zone.code, zone.name)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due by">
          <Input type="date" value={crossDueOn} min={istDateKey(Date.now()) ?? undefined} onChange={(event) => setCrossDueOn(event.target.value)} />
        </Field>
        <p className="mt-3">
          Every Zone Leader of the Unit gets a notification asking them to audit {crossZone ? zoneDisplayLabel(crossZone.code, crossZone.name) : 'this Zone'}
          {crossDueOn ? ` by ${formatDate(`${crossDueOn}T12:00:00+05:30`)}` : ''}. It stays on their list, marked overdue after that day, until one of them audits it.
        </p>
      </ConfirmDialog>

      <Card>
        <CardHeader title="Start an audit" />
        <div className="space-y-4 p-4">
          {catalogue.error ? <ErrorNotice error={catalogue.error} /> : null}
          {open.error ? <ErrorNotice error={open.error} /> : null}
          {units.length > 1 ? (
            <Field label="Unit">
              <Combobox value={unit} onChange={setUnitId} options={units.map((u) => ({ id: u.id, label: u.name }))} placeholder="Search Units…" spellCheck={false} />
            </Field>
          ) : null}
          {!unit || open.isLoading ? null : openHere && !another ? (
            <div className="space-y-3">
              <p className="gb-notice">
                Your audit of this Unit is {openHere.status === 'PAUSED' ? 'paused' : 'not submitted yet'}. A new audit is for a different Zone.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => toAudit(openHere.id)}>{openHere.status === 'PAUSED' ? 'Resume it' : 'Carry on with it'}</Button>
                <Button variant="secondary" onClick={() => setAnother(true)}>
                  Start a new audit
                </Button>
              </div>
            </div>
          ) : types.length > 1 ? (
            <div className="gb-field">
              <span className="gb-label">Which audit?</span>
              <div className="flex flex-wrap gap-2">
                {types.map((type) => (
                  <Button key={type} variant={type === auditType ? 'primary' : 'secondary'} onClick={() => setPicked(type)}>
                    {AUDIT_TYPE_LABEL[type]}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {device.error ? <ErrorNotice error={device.error} /> : null}
          {unit && auditType && device.client && !open.isLoading && (!openHere || another) ? (
            <div className="max-w-md">
              <LiveCapture facing="user" openLabel="Open the camera for your selfie" onCapture={(blob) => start.mutate(blob)} />
            </div>
          ) : null}
          {start.isPending ? <p className="text-sm text-ink-2" role="status">Starting the audit…</p> : null}
          <ErrorNotice error={start.error} />
        </div>
      </Card>
    </div>
  );
}
