import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAuditCompleted, zoneDisplayLabel } from '@audit5s/domain';
import type { Audit, AuditDetail, Page, ReportSnapshot, Unit } from '@audit5s/contracts';
import { api, fetchAll } from '@/lib/api';
import { Button, Combobox, Dialog, ErrorNotice, Field, Select, Spinner } from '@/components/ui';
import { PreviewButton, SummaryZonePicker } from './SummaryZonePicker';
import { zoneDocumentKey } from './report-library';
import { REPORT_EDITION_LABEL } from '@/lib/labels';
import { formatDate, formatDateTime } from '@audit5s/domain';

export type NewReportPreset =
  | { mode: 'ZONE'; auditId?: string }
  | { mode: 'SUMMARY'; unitId?: string };

/**
 * One way to issue a report (§8.9): say what kind, say what it covers, preview, generate.
 *
 * A Zone report is issued as whichever edition is chosen here — initial or after-evidence —
 * however many times the Zone's findings have been answered or closed.
 *
 * The scope is chosen inside the dialog, never read from the history's Unit filter: a
 * filter that also steered generation was the page's most confusing control.
 */
export function NewReportDialog({
  open,
  preset,
  snapshots,
  onClose,
  onQueued,
}: {
  open: boolean;
  preset: NewReportPreset;
  snapshots: readonly ReportSnapshot[];
  onClose: () => void;
  onQueued: (snapshot: ReportSnapshot) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="New report"
      description="Preview it first if you like; nothing is issued until you press Generate."
    >
      {/* Remounted per opening, so a dialog reopened starts from its preset, not from leftovers. */}
      {open ? <NewReportForm preset={preset} snapshots={snapshots} onQueued={onQueued} onClose={onClose} /> : null}
    </Dialog>
  );
}

function NewReportForm({
  preset,
  snapshots,
  onQueued,
  onClose,
}: {
  preset: NewReportPreset;
  snapshots: readonly ReportSnapshot[];
  onQueued: (snapshot: ReportSnapshot) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'ZONE' | 'SUMMARY'>(preset.mode);

  return (
    <>
      <div className="gb-dialog-section">
        <fieldset>
          <legend className="gb-label mb-2">What kind of report?</legend>
          <div className="gb-choice">
            <label>
              <input
                type="radio"
                name="report-kind"
                checked={mode === 'ZONE'}
                onChange={() => setMode('ZONE')}
              />
              <b>Zone report</b>
              <span>One audited Zone, with its findings and photos.</span>
            </label>
            <label>
              <input
                type="radio"
                name="report-kind"
                checked={mode === 'SUMMARY'}
                onChange={() => setMode('SUMMARY')}
              />
              <b>Unit summary</b>
              <span>Several Zones of one Unit, chosen from its finished audits.</span>
            </label>
          </div>
        </fieldset>
      </div>

      {mode === 'ZONE' ? (
        <ZoneReportForm
          initialAuditId={preset.mode === 'ZONE' ? (preset.auditId ?? '') : ''}
          snapshots={snapshots}
          onQueued={onQueued}
          onClose={onClose}
        />
      ) : (
        <SummaryForm
          initialUnitId={preset.mode === 'SUMMARY' ? (preset.unitId ?? '') : ''}
          onQueued={onQueued}
        />
      )}
    </>
  );
}

function ZoneReportForm({
  initialAuditId,
  snapshots,
  onQueued,
  onClose,
}: {
  initialAuditId: string;
  snapshots: readonly ReportSnapshot[];
  onQueued: (snapshot: ReportSnapshot) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [auditId, setAuditId] = useState(initialAuditId);
  const [auditZoneId, setAuditZoneId] = useState('');
  const [edition, setEdition] = useState<'INITIAL_ZONE' | 'AFTER_EVIDENCE_ZONE'>('INITIAL_ZONE');

  const audits = useQuery({
    queryKey: ['audits', 'completed', 'all-units'],
    queryFn: () => fetchAll<Audit>('/audits?limit=200'),
  });

  // Only a completed audit can be reported on (§10.2). Newest first: the report someone
  // wants is nearly always the audit that just finished. Unit first in the label, so typing
  // a Unit's name narrows to its audits; the time tells two audits of one day apart.
  const options = useMemo(
    () =>
      (audits.data ?? [])
        .filter((audit) => isAuditCompleted(audit.status) && audit.completedAt !== null)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
        .map((audit) => ({
          id: audit.id,
          label: `${audit.unitName} · ${formatDateTime(audit.completedAt)} · ${audit.auditorName}`,
        })),
    [audits.data],
  );

  // The audit's Zones come with the audit (`GET /audits/{id}`, §8.6).
  const detail = useQuery({
    queryKey: ['audit-detail', auditId],
    queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`),
    enabled: Boolean(auditId),
  });
  const zones = (detail.data?.zones ?? []).filter((zone) => zone.status !== 'WITHDRAWN');

  const body = { kind: edition, auditZoneId };

  // What this Zone already has, so a second issue is a decision rather than an accident.
  const existing = useMemo(() => {
    if (!auditZoneId) return null;
    const key = zoneDocumentKey(auditZoneId);
    return (
      snapshots
        .filter((snapshot) => snapshot.kind !== 'MULTI_ZONE_SUMMARY' && zoneDocumentKey(snapshot.auditZoneId) === key)
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }, [snapshots, auditZoneId]);

  const generate = useMutation({
    mutationFn: () => api.post<ReportSnapshot>('/reports/generate', body),
    onSuccess: (snapshot) => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onQueued(snapshot);
    },
  });

  return (
    <>
      <div className="gb-dialog-section grid gap-3">
        <Field label="Audit" hint="Finished audits only, newest first. Type a Unit, date or auditor to narrow.">
          {audits.isLoading ? (
            <Spinner label="Loading audits…" />
          ) : (
            <Combobox
              value={auditId}
              keepOrder
              onChange={(id) => {
                setAuditId(id);
                setAuditZoneId('');
              }}
              options={options}
              placeholder="Search audits…"
            />
          )}
        </Field>
        {audits.error ? <ErrorNotice error={audits.error} /> : null}

        <Field
          label="Zone"
          hint={auditId ? 'A Zone the auditor has not finished cannot be reported on yet.' : 'Choose an audit first.'}
        >
          <Select
            value={auditZoneId}
            onChange={(event) => setAuditZoneId(event.target.value)}
            disabled={!auditId || detail.isLoading}
          >
            <option value="">{detail.isLoading ? 'Loading Zones…' : 'Choose a Zone…'}</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id} disabled={zone.status !== 'COMPLETED'}>
                {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                {zone.status === 'COMPLETED' ? '' : ' (not finished)'}
              </option>
            ))}
          </Select>
        </Field>
        {detail.error ? <ErrorNotice error={detail.error} /> : null}

        <fieldset>
          <legend className="gb-label mb-2">Edition</legend>
          <div className="gb-choice">
            <label>
              <input
                type="radio"
                name="report-edition"
                checked={edition === 'INITIAL_ZONE'}
                onChange={() => setEdition('INITIAL_ZONE')}
              />
              <b>Initial</b>
              <span>The findings as audited, with space for the after-evidence.</span>
            </label>
            <label>
              <input
                type="radio"
                name="report-edition"
                checked={edition === 'AFTER_EVIDENCE_ZONE'}
                onChange={() => setEdition('AFTER_EVIDENCE_ZONE')}
              />
              <b>After-evidence</b>
              <span>The findings with the answers and after-photos received so far.</span>
            </label>
          </div>
        </fieldset>
        {existing ? (
          <p className="gb-notice m-0">
            This Zone already has v{existing.version} ({REPORT_EDITION_LABEL[existing.kind]}, generated{' '}
            {formatDate(existing.generatedAt)}). Generating issues v{existing.version + 1}; v
            {existing.version} stays in the history.
          </p>
        ) : null}
        {generate.error ? <ErrorNotice error={generate.error} /> : null}
      </div>

      <div className="gb-dialog-actions">
        {!auditZoneId ? <span className="gb-hint">Choose an audit and a Zone to continue.</span> : null}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <PreviewButton disabled={!auditZoneId} body={body} />
        <Button onClick={() => generate.mutate()} disabled={!auditZoneId || generate.isPending}>
          {generate.isPending ? 'Queuing…' : existing ? `Generate v${existing.version + 1}` : 'Generate'}
        </Button>
      </div>
    </>
  );
}

function SummaryForm({
  initialUnitId,
  onQueued,
}: {
  initialUnitId: string;
  onQueued: (snapshot: ReportSnapshot) => void;
}) {
  const [unitId, setUnitId] = useState(initialUnitId);

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  return (
    <div className="gb-dialog-section grid gap-3">
      <Field label="Unit" hint="The summary covers Zones of this Unit only.">
        <Combobox
          value={unitId}
          onChange={setUnitId}
          options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
          placeholder="Search Units…"
        />
      </Field>
      {units.error ? <ErrorNotice error={units.error} /> : null}
      {unitId ? (
        <SummaryZonePicker key={unitId} unitId={unitId} onQueued={onQueued} />
      ) : (
        <p className="m-0 text-[12.5px] text-ink-2">
          Choose a Unit to see its finished audits and pick the Zones to summarise.
        </p>
      )}
    </div>
  );
}
