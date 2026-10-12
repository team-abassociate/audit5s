import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Audit, AuditType, Page } from '@audit5s/contracts';
import { formatDateTime, uuidv7 } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import { Button, Card, CardHeader, EmptyState, ErrorNotice, Field, Segmented, Select, Skeleton, StatusChip, Table, Td, Th } from '@/components/ui';
import { api } from '@/lib/api';
import { useWebDevice } from '@/lib/device';
import { uploadEvidence } from '@/lib/evidence';
import { LiveCapture } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { AUDIT_TYPE_LABEL, startableTypes, useCatalogue } from './shared';

/**
 * Run an audit on the web (R-51): the phone's Unit page (`audit-start.tsx`) at a desk.
 * Your open audits first — continuing one beats starting a second and splitting the day's
 * Zones across two — then a new one: the Unit, the type, and the selfie, which is a live
 * webcam photograph (§7.1, §12.10). The audit is created as this browser's, then started.
 */
export function ConductStartPage() {
  useDocumentTitle('Run an audit');
  const { user, can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const device = useWebDevice();
  const catalogue = useCatalogue();
  const types = startableTypes(can);
  const [picked, setPicked] = useState<AuditType | null>(null);
  const [unitId, setUnitId] = useState('');
  const [selfie, setSelfie] = useState(false);
  const auditType = picked ?? types[0] ?? null;

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

  if (types.length === 0) return <EmptyState title="Your role does not conduct audits." />;
  const openHere = (open.data?.data ?? []).find((audit) => audit.unitId === unit);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Your open audits" description="Started here or on your phone. Continue one rather than starting a second for the same Unit." />
        {open.isLoading ? (
          <Skeleton variant="rows" columns={['Unit', 'Type', 'Status', 'Started']} />
        ) : open.error ? (
          <div className="p-4">
            <ErrorNotice error={open.error} />
          </div>
        ) : (open.data?.data.length ?? 0) === 0 ? (
          <EmptyState title="No open audits." />
        ) : (
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
              {open.data!.data.map((audit) => (
                <tr key={audit.id}>
                  <Td>{audit.unitName}</Td>
                  <Td>{AUDIT_TYPE_LABEL[audit.auditType]}</Td>
                  <Td>
                    <StatusChip kind="audit" status={audit.status} />
                  </Td>
                  <Td className="gb-data">{audit.startedAt ? formatDateTime(audit.startedAt) : '—'}</Td>
                  <Td className="text-right">
                    <Button variant="secondary" onClick={() => void navigate({ to: '/conduct/$auditId', params: { auditId: audit.id } })}>
                      {audit.status === 'PAUSED' ? 'Resume' : 'Continue'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Start an audit" description="Your selfie first, then the Zone. The selfie is a live photograph from this computer's camera." />
        <div className="space-y-4 p-4">
          {catalogue.error ? <ErrorNotice error={catalogue.error} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Unit">
              <Select value={unit} onChange={(event) => setUnitId(event.target.value)} disabled={units.length <= 1}>
                {units.length !== 1 ? <option value="">Choose the Unit</option> : null}
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            {types.length > 1 && auditType ? (
              <div className="gb-field">
                <span className="gb-label">Type</span>
                <Segmented label="Audit type" options={types.map((value) => ({ value, label: AUDIT_TYPE_LABEL[value] }))} value={auditType} onChange={setPicked} />
              </div>
            ) : (
              <Field label="Type">
                <Select value={auditType ?? ''} disabled>
                  <option>{auditType ? AUDIT_TYPE_LABEL[auditType] : ''}</option>
                </Select>
              </Field>
            )}
          </div>
          {openHere ? (
            <p className="gb-notice">
              Your audit of this Unit is still open. Add the next Zone to it rather than starting a new one; a new audit is scored separately.
            </p>
          ) : null}
          {device.error ? <ErrorNotice error={device.error} /> : null}
          {!unit ? null : selfie ? (
            <div className="max-w-md">
              <LiveCapture facing="user" openLabel="Open the camera for your selfie" onCapture={(blob) => start.mutate(blob)} />
            </div>
          ) : (
            <Button disabled={!device.client} onClick={() => setSelfie(true)}>
              Take selfie
            </Button>
          )}
          {start.isPending ? <p className="text-sm text-ink-2" role="status">Starting the audit…</p> : null}
          <ErrorNotice error={start.error} />
        </div>
      </Card>
    </div>
  );
}
