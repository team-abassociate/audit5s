import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AuditDetail, ZoneLocksResponse } from '@audit5s/contracts';
import { MAX_AUDIT_RESTARTS, isAuditCompleted, restartsRemaining, uuidv7, zoneCodeForLabel, zoneDisplayLabel } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogActions,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Select,
  Slip,
  Spinner,
  StatusChip,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useWebDevice } from '@/lib/device';
import { LiveCapture } from '@/lib/photo';
import { uploadEvidence } from '@/lib/evidence';
import { AUDIT_TYPE_LABEL, useAuditDetail, useCatalogue, versionsForUnit, withdrawZone } from './shared';

type AuditZone = AuditDetail['zones'][number];

/**
 * One audit being conducted on the web (R-51): the phone's Zones screen
 * (`audit/zones/[auditId].tsx`). The next Zone first — one of the Unit's Zones (a Super Admin
 * or Coordinator may add one, R-52), an optional description, the Zone Leader's name and, on
 * a scored audit, the department — then the
 * Zones already in it, then Save & pause and Finish. A Zone another open audit holds is
 * refused before forty minutes of questions, not after (R-29).
 *
 * The browser must own the audit to write to it (D7). A paused audit is resumed here, which
 * claims it for this browser; one still open on a phone says so and offers nothing.
 */
export function AuditRunPage({ auditId }: { auditId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const device = useWebDevice();
  const detail = useAuditDetail(auditId);
  const catalogue = useCatalogue();
  const audit = detail.data;
  useDocumentTitle(audit ? `${AUDIT_TYPE_LABEL[audit.auditType]} · ${audit.unitName}` : 'Audit');

  const { can } = useSession();
  const mayAddZone = can('zone', 'create');
  const [zoneCode, setZoneCode] = useState<string | null>(null);
  // R-52: a Zone added here — its label (`1A`, at most 3) and name, on one line.
  const [newZone, setNewZone] = useState<{ label: string; name: string } | null>(null);
  const [description, setDescription] = useState('');
  const [leaderName, setLeaderName] = useState('');
  const [versionId, setVersionId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [editing, setEditing] = useState<{ zone: AuditZone; description: string; leaderName: string } | null>(null);
  const [aborting, setAborting] = useState<AuditZone | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [restartReason, setRestartReason] = useState<string | null>(null);

  const locks = useQuery({
    queryKey: ['conduct', 'locks', auditId],
    queryFn: () => api.get<ZoneLocksResponse>(`/audits/${auditId}/zone-locks`),
    enabled: audit?.status === 'IN_PROGRESS' || audit?.status === 'PAUSED',
    refetchInterval: 60_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['conduct'] });
  const client = device.client;

  const resume = useMutation({
    mutationFn: () => client!.post(`/audits/${auditId}/resume`, { deviceId: device.deviceId }, uuidv7()),
    onSuccess: refresh,
  });
  // An audit left at ASSIGNED: the selfie never reached the server, so it is taken here.
  const selfie = useMutation({
    mutationFn: async (photo: Blob) => {
      await uploadEvidence(photo, { kind: 'AUDITOR_SELFIE', auditId, isLiveCapture: true }, client!);
      await client!.post(`/audits/${auditId}/start`, { startedAt: new Date().toISOString() }, uuidv7());
    },
    onSuccess: refresh,
  });
  const pause = useMutation({
    mutationFn: () => client!.post(`/audits/${auditId}/pause`, {}, uuidv7()),
    onSuccess: async () => {
      await refresh();
      void navigate({ to: '/conduct' });
    },
  });
  const finish = useMutation({
    mutationFn: () => client!.post(`/audits/${auditId}/complete`, { completedAt: new Date().toISOString() }, uuidv7()),
    onSuccess: async () => {
      setFinishing(false);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
    },
  });
  const restart = useMutation({
    mutationFn: (justification: string) => client!.post(`/audits/${auditId}/restart`, { justification }, uuidv7()),
    onSuccess: async () => {
      setRestartReason(null);
      await refresh();
    },
  });
  const addZone = useMutation({
    mutationFn: async () => {
      const auditZoneId = uuidv7();
      await client!.put(
        `/audits/${auditId}/zones/${auditZoneId}`,
        {
          zoneCode: pickedCode,
          ...(newZone?.name.trim() ? { zoneName: newZone.name.trim() } : {}),
          sequenceNo: (audit?.zones.length ?? 0) + 1,
          ...(walkBy ? {} : { checklistVersionId: versionId }),
          zoneDescription: description.trim() || null,
          zoneLeaderName: leaderName.trim(),
          clientUpdatedAt: new Date().toISOString(),
        },
        auditZoneId,
      );
      return auditZoneId;
    },
    onSuccess: async (auditZoneId) => {
      await refresh();
      void navigate({ to: '/conduct/$auditId/$auditZoneId', params: { auditId, auditZoneId } });
    },
  });
  const editZone = useMutation({
    mutationFn: (next: NonNullable<typeof editing>) =>
      client!.put(
        `/audits/${auditId}/zones/${next.zone.id}`,
        {
          zoneId: next.zone.zoneId,
          sequenceNo: next.zone.sequenceNo,
          zoneDescription: next.description.trim() || null,
          zoneLeaderName: next.leaderName.trim() || null,
          clientUpdatedAt: new Date().toISOString(),
        },
        uuidv7(),
      ),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const abort = useMutation({
    mutationFn: (zone: AuditZone) => withdrawZone(client!, device.deviceId!, auditId, zone.id),
    onSuccess: async () => {
      setAborting(null);
      await refresh();
    },
  });

  if (detail.isLoading || catalogue.isLoading) return <Spinner />;
  if (detail.error) return <ErrorNotice error={detail.error} missing="This audit doesn't exist, or isn't yours." />;
  if (!audit) return null;

  const walkBy = audit.auditType === 'WALK_BY';
  // No holder (a restarted audit) is anyone's to carry on; the server checks the same way.
  const mine = audit.owningDeviceId === null || audit.owningDeviceId === device.deviceId;
  const live = audit.zones.filter((zone) => zone.status !== 'WITHDRAWN');
  const allComplete = live.length > 0 && live.every((zone) => zone.status === 'COMPLETED');
  const running = audit.status === 'IN_PROGRESS' && mine;
  const elsewhere = (audit.status === 'IN_PROGRESS' || audit.status === 'PAUSED') && !mine;
  const canAddZone = running && (live.length === 0 || allComplete);
  const canFinish = running && allComplete;
  const restartsLeft = restartsRemaining(audit.restartCount);
  const finished = isAuditCompleted(audit.status);
  const canRestart = finished && restartsLeft > 0;

  const zones = catalogue.data?.zones.filter((zone) => zone.unitId === audit.unitId) ?? [];
  const byCode = new Map(zones.map((zone) => [zone.code, zone]));
  const used = new Set(live.map((zone) => zone.zoneCodeSnapshot));
  const lockedByCode = new Map((locks.data?.locks ?? []).map((lock) => [lock.zoneCode, lock]));
  const versions = catalogue.data ? versionsForUnit(catalogue.data, audit.unitId) : [];
  const newCode = newZone ? zoneCodeForLabel(newZone.label) : null;
  const pickedCode = newZone ? newCode : zoneCode;
  const lock = zoneCode === null || newZone ? null : lockedByCode.get(zoneCode);
  const errors = {
    zone: newZone
      ? newCode === null
        ? 'Enter 1 to 3 letters or digits'
        : byCode.has(newCode) || used.has(newCode)
          ? `Zone ${newZone.label} already exists. Choose it from the list.`
          : null
      : zoneCode === null
        ? 'Choose the Zone'
        : lock
          ? 'Another audit holds this Zone'
          : null,
    leader: leaderName.trim() === '' ? 'Enter the Zone Leader’s name' : null,
    department: !walkBy && !versionId ? 'Choose the department' : null,
  };

  // Choosing a Zone fills in what the Unit's catalogue knows about it (the phone's `chooseZone`).
  const chooseZone = (code: string | null) => {
    setZoneCode(code);
    setShowErrors(false);
    const known = code === null ? undefined : byCode.get(code);
    if (!known) return;
    if (!description.trim()) setDescription(known.description ?? '');
    if (!leaderName.trim()) setLeaderName(known.zoneLeaderName ?? '');
    if (!versionId && known.defaultChecklistTemplateId) {
      setVersionId(versions.find((version) => version.templateId === known.defaultChecklistTemplateId)?.id ?? '');
    }
  };

  const openZone = (zone: AuditZone) => void navigate({ to: '/conduct/$auditId/$auditZoneId', params: { auditId, auditZoneId: zone.id } });

  return (
    <div className="space-y-4">
      {audit.status === 'PAUSED' && mine ? (
        <Slip title="Paused">
          Everything is saved. Resume to carry on.
          <span className="mt-2 block">
            <Button disabled={!client || resume.isPending} onClick={() => resume.mutate()}>
              {resume.isPending ? 'Resuming…' : 'Resume'}
            </Button>
          </span>
        </Slip>
      ) : elsewhere ? (
        // D7: an audit belongs to the device that ran it until it is finished. Nothing here
        // moves it; a Super Admin's "release device" is the one way, and it is logged.
        <Slip title={audit.status === 'PAUSED' ? 'Paused on another device' : 'Open on another device'}>
          This audit is held by the phone or browser it was started on. Carry it on there. If that device is lost, a Super Admin can
          release it from the audit's page.
        </Slip>
      ) : audit.status === 'ASSIGNED' ? (
        <Slip title="Take your selfie to begin">A live photograph from this computer's camera starts the audit.</Slip>
      ) : null}
      <ErrorNotice error={resume.error ?? pause.error ?? finish.error ?? device.error} />

      {audit.status === 'ASSIGNED' ? (
        <Card>
          <CardHeader title="1 · Take your selfie" />
          <div className="max-w-md p-4">
            <LiveCapture facing="user" openLabel="Open the camera for your selfie" onCapture={(blob) => selfie.mutate(blob)} />
            <ErrorNotice error={selfie.error} />
          </div>
        </Card>
      ) : null}

      {canAddZone ? (
        <Card>
          <CardHeader
            title={audit.zones.length === 0 ? 'Select Zone' : 'Select the next Zone'}
            description={walkBy ? 'Where the walk-by goes, and who leads it.' : 'Each Zone is its own questionnaire of the department you choose.'}
          />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {newZone ? (
              <Field label="New Zone" {...(showErrors && errors.zone ? { error: errors.zone } : {})}>
                <div className="flex gap-2">
                  <Input
                    aria-label="Zone no."
                    className="max-w-20 gb-data"
                    value={newZone.label}
                    maxLength={3}
                    placeholder="1A"
                    onChange={(event) =>
                      setNewZone({ ...newZone, label: event.target.value.replace(/[^0-9a-z]/gi, '').slice(0, 3).toUpperCase() })
                    }
                  />
                  <Input
                    aria-label="Zone name"
                    value={newZone.name}
                    maxLength={200}
                    placeholder="Zone name"
                    onChange={(event) => setNewZone({ ...newZone, name: event.target.value })}
                  />
                </div>
                <button type="button" className="mt-1 text-sm underline" onClick={() => setNewZone(null)}>
                  Choose one of the Unit’s Zones instead
                </button>
              </Field>
            ) : (
              <Field label="Zone" {...(showErrors && errors.zone ? { error: errors.zone } : {})}>
                <Select value={zoneCode ?? ''} onChange={(event) => chooseZone(event.target.value || null)}>
                  <option value="">{zones.length === 0 ? 'This Unit has no Zones yet' : 'Choose the Zone'}</option>
                  {zones.map((zone) => {
                    const held = lockedByCode.get(zone.code);
                    return (
                      <option key={zone.id} value={zone.code} disabled={used.has(zone.code) || Boolean(held)}>
                        {zoneDisplayLabel(zone.code, zone.name)}
                        {used.has(zone.code) ? ' · in this audit' : held ? ` · ${held.auditorName} is auditing it` : ''}
                      </option>
                    );
                  })}
                </Select>
                {mayAddZone ? (
                  <button
                    type="button"
                    className="mt-1 text-sm underline"
                    onClick={() => {
                      setNewZone({ label: '', name: '' });
                      setShowErrors(false);
                    }}
                  >
                    + New Zone
                  </button>
                ) : zones.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-2">Ask the Unit’s Coordinator to add its Zones.</p>
                ) : null}
              </Field>
            )}
            <Field label="Zone Leader’s name" {...(showErrors && errors.leader ? { error: errors.leader } : {})}>
              <Input value={leaderName} maxLength={200} onChange={(event) => setLeaderName(event.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Zone description (optional)">
              <Input value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="What this Zone covers" />
            </Field>
            {walkBy ? null : (
              <Field label="Department" {...(showErrors && errors.department ? { error: errors.department } : {})}>
                <Select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
                  <option value="">Choose the department</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.templateName} · {version.totalQuestions} questions
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div className="space-y-2 px-4 pb-4">
            <ErrorNotice error={addZone.error} />
            <Button
              disabled={addZone.isPending}
              onClick={() => {
                if (errors.zone || errors.leader || errors.department) setShowErrors(true);
                else addZone.mutate();
              }}
            >
              {addZone.isPending ? 'Creating…' : walkBy ? 'Start the photographs' : 'Start the questions'}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Zones in this audit"
          description={`${live.filter((zone) => zone.status === 'COMPLETED').length} of ${live.length} finished${audit.zones.length > live.length ? ` · ${audit.zones.length - live.length} aborted` : ''}`}
          action={
            <div className="flex flex-wrap gap-2">
              {running ? (
                <Button variant="secondary" disabled={pause.isPending} onClick={() => pause.mutate()}>
                  Save &amp; pause
                </Button>
              ) : null}
              {running ? (
                <Button disabled={!canFinish} onClick={() => setFinishing(true)}>
                  Finish audit
                </Button>
              ) : null}
              {canRestart ? (
                <Button variant="secondary" onClick={() => setRestartReason('')}>
                  Restart ({restartsLeft})
                </Button>
              ) : null}
              {finished ? (
                <Link to="/audits" search={{ audit: audit.id } as never} className="gb-btn">
                  Open the result
                </Link>
              ) : null}
            </div>
          }
        />
        {audit.zones.length === 0 ? (
          <EmptyState title="No Zones yet." />
        ) : (
          <ul className="divide-y divide-edge-soft">
            {audit.zones.map((zone) => (
              <li key={zone.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-bold text-ink">{zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}</p>
                  <p className="text-sm text-ink-2">
                    {[zone.checklistTemplateNameSnapshot, zone.zoneLeaderNameSnapshot && `Leader ${zone.zoneLeaderNameSnapshot}`].filter(Boolean).join(' · ')}
                  </p>
                  {zone.status === 'WITHDRAWN' ? (
                    <p className="text-sm text-ink-2">Aborted: its answers are out of this audit and it is not scored.</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip kind="zone" status={zone.status} />
                  {zone.status !== 'WITHDRAWN' ? (
                    <Button variant="secondary" onClick={() => openZone(zone)}>
                      {zone.status === 'COMPLETED' || !running ? 'Review' : 'Open'}
                    </Button>
                  ) : null}
                  {running && zone.status !== 'WITHDRAWN' ? (
                    <Button
                      variant="secondary"
                      onClick={() => setEditing({ zone, description: zone.zoneDescriptionSnapshot ?? '', leaderName: zone.zoneLeaderNameSnapshot ?? '' })}
                    >
                      Edit details
                    </Button>
                  ) : null}
                  {running && zone.status !== 'COMPLETED' && zone.status !== 'WITHDRAWN' ? (
                    <Button variant="secondary" onClick={() => setAborting(zone)}>
                      Abort Zone
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={finishing}
        title="Finish this audit?"
        tone="primary"
        confirmLabel="Finish audit"
        pending={finish.isPending}
        error={finish.error}
        onConfirm={() => finish.mutate()}
        onCancel={() => setFinishing(false)}
      >
        {live.length} Zone(s) will be submitted and scored. A finished audit cannot be reopened from here except by a restart, and any
        nonconformity photographs become corrective actions. Check you have audited every Zone you meant to.
      </ConfirmDialog>

      <ConfirmDialog
        open={aborting !== null}
        title={aborting ? `Abort ${zoneDisplayLabel(aborting.zoneCodeSnapshot, aborting.zoneNameSnapshot)}?` : 'Abort Zone?'}
        confirmLabel="Abort this Zone"
        pending={abort.isPending}
        error={abort.error}
        onConfirm={() => aborting && abort.mutate(aborting)}
        onCancel={() => setAborting(null)}
      >
        Its answers are cleared from this audit and it leaves the score. The rest of the audit carries on, and you can start this Zone again.
      </ConfirmDialog>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? zoneDisplayLabel(editing.zone.zoneCodeSnapshot, editing.zone.zoneNameSnapshot) : 'Zone details'}>
        {editing ? (
          <div className="gb-dialog-section space-y-3">
            <Field label="Description">
              <Input value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
            </Field>
            <Field label="Zone Leader">
              <Input value={editing.leaderName} onChange={(event) => setEditing({ ...editing, leaderName: event.target.value })} />
            </Field>
            <ErrorNotice error={editZone.error} />
          </div>
        ) : null}
        <DialogActions>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button disabled={editZone.isPending} onClick={() => editing && editZone.mutate(editing)}>
            Save details
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={restartReason !== null} onClose={() => setRestartReason(null)} title="Restart this audit?">
        <div className="gb-dialog-section space-y-3">
          <p className="text-sm text-ink-2">
            {restartsLeft === MAX_AUDIT_RESTARTS
              ? `An audit can be restarted ${MAX_AUDIT_RESTARTS} times. This would be the first.`
              : `${restartsLeft} restart${restartsLeft === 1 ? '' : 's'} left on this audit.`}{' '}
            It goes back to in progress so you can correct it, and anything it raised for a Zone Leader stops until you finish it again.
          </p>
          <Field label="Why are you restarting it?" hint="At least 10 characters.">
            <textarea className="gb-input" rows={3} value={restartReason ?? ''} onChange={(event) => setRestartReason(event.target.value)} />
          </Field>
          <ErrorNotice error={restart.error} />
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={() => setRestartReason(null)}>
            Leave it finished
          </Button>
          <Button
            disabled={restart.isPending || (restartReason ?? '').trim().length < 10 || !client}
            onClick={() => restart.mutate((restartReason ?? '').trim())}
          >
            Restart audit
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
