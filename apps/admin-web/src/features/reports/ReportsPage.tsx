import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zoneDisplayLabel } from '@audit5s/domain';
import {
  type Audit,
  type AuditDetail,
  type Page,
  type ReportAccessToken,
  type ReportDownloadUrl,
  type ReportKind,
  type ReportSnapshot,
  type Unit,
} from '@audit5s/contracts';
import { api, ApiError, fetchAll } from '@/lib/api';
import { PreviewButton, SummaryZonePicker } from './SummaryZonePicker';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Combobox,
  ErrorNotice,
  Field,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';

/**
 * Reports (PART 14, Phase 7's Web row).
 *
 * Three things live here and they are deliberately on one page, because they are one
 * workflow: generate a report, look at the version history, and manage the links the
 * report handed out.
 *
 * The page never hides an earlier version (§10.5). An external certification body may need
 * to see exactly what was issued on a given date, and a UI that quietly offers only the
 * latest cannot serve that — so the history lists every version with its generation date
 * and each one stays downloadable.
 */

const KIND_LABEL: Record<ReportKind, string> = {
  INITIAL_ZONE: 'Initial Zone report',
  AFTER_EVIDENCE_ZONE: 'After-evidence report',
  MULTI_ZONE_SUMMARY: 'Unit summary report',
};

/** The kinds that name one audited Zone; the summary has its own picker. */
const ZONE_REPORT_KINDS = ['INITIAL_ZONE', 'AFTER_EVIDENCE_ZONE'] as const;
type ZoneReportKind = (typeof ZONE_REPORT_KINDS)[number];

export function ReportsPage() {
  const { can } = useSession();
  const mayGenerate = can('report', 'generate');

  const [unitId, setUnitId] = useState('');
  const [tokensFor, setTokensFor] = useState<ReportSnapshot | null>(null);

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });

  const selectedUnit = unitId || units.data?.data[0]?.id || '';

  const reports = useQuery({
    queryKey: ['reports', selectedUnit],
    queryFn: () => api.get<Page<ReportSnapshot>>(`/reports?limit=200&unitId=${selectedUnit}`),
    enabled: Boolean(selectedUnit),
    // A queued report becomes ready in the background; the page notices without a reload.
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((row) => row.status === 'QUEUED' || row.status === 'RENDERING')
        ? 4_000
        : 60_000,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Reports"
          description={
            'Every report is rendered from a frozen snapshot, so one reopened in December ' +
            'is the document that was issued in March. Regenerating adds a version; it ' +
            'never replaces one.'
          }
          action={
            <div className="w-64">
              <Field label="Unit">
                <Combobox
                  value={selectedUnit}
                  onChange={setUnitId}
                  options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
                  placeholder="Search Units…"
                />
              </Field>
            </div>
          }
        />
      </Card>

      {mayGenerate && selectedUnit ? (
        <GeneratePanel unitId={selectedUnit} onUnitChange={setUnitId} />
      ) : null}

      <Card>
        <CardHeader title="Version history" description="Newest first. Nothing here is ever replaced." />
        {reports.isLoading ? <Spinner /> : null}
        {reports.error ? <ErrorNotice error={reports.error} /> : null}
        {reports.data ? (
          <VersionHistory
            snapshots={reports.data.data}
            mayGenerate={mayGenerate}
            onManageTokens={setTokensFor}
          />
        ) : null}
      </Card>

      {tokensFor ? <TokensPanel snapshot={tokensFor} onClose={() => setTokensFor(null)} /> : null}
    </div>
  );
}

/**
 * The generation form (§8.9).
 *
 * A zone report names one completed audit-Zone. A unit summary names a **selection** of
 * audited Zones, chosen in `SummaryZonePicker` — any Zones, from any of the Unit's finished
 * audits. The selection is stored on the snapshot, so the report is reproducible and its
 * scope unambiguous.
 */
function GeneratePanel({
  unitId,
  onUnitChange,
}: {
  unitId: string;
  onUnitChange: (unitId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [kind, setKind] = useState<ZoneReportKind>('INITIAL_ZONE');
  const [auditId, setAuditId] = useState('');
  const [auditZoneId, setAuditZoneId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Every audit the actor may see, not only the Unit picked at the top of the page. A
  // report names one audit-Zone and nothing else, so scoping this list to the current Unit
  // hid every audit of every other Unit behind a selector a person had no reason to touch
  // first — the page looked like it had forgotten most of the work. Choosing an audit
  // switches the Unit instead, which keeps the history below showing what was just queued.
  const audits = useQuery({
    queryKey: ['audits', 'completed', 'all-units'],
    queryFn: () => fetchAll<Audit>('/audits?limit=200'),
  });

  // The audit's Zones come with the audit (`GET /audits/{id}`, §8.6). There is no
  // `GET /audits/{id}/zones`: asking for one returned 404, which left the Zone picker empty
  // and the Generate button permanently disabled.
  const auditZones = useQuery({
    queryKey: ['audit-detail', auditId],
    queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`),
    enabled: Boolean(auditId),
  });

  // Only a completed audit can be reported on (§10.2), so the picker offers no other.
  // Newest first: the report someone wants is nearly always the audit that just finished.
  const completedAudits = useMemo(
    () =>
      (audits.data ?? [])
        .filter((audit) => audit.completedAt !== null)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)),
    [audits.data],
  );

  const generate = useMutation({
    mutationFn: () => api.post<ReportSnapshot>('/reports/generate', { kind, auditZoneId }),
    onSuccess: (snapshot) => {
      setNotice(
        `Version ${snapshot.version} queued. It renders in the background; the history ` +
          'updates when it is ready.',
      );
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  return (
    <Card>
      <CardHeader
        title="Generate a report"
        description="Rendering happens in the background; this returns as soon as the payload is frozen."
      />
      <div className="space-y-3 px-4 py-3">
        <div className="space-y-3 border-b border-edge-soft pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={summaryOpen ? 'secondary' : 'primary'}
              onClick={() => setSummaryOpen((open) => !open)}
              aria-expanded={summaryOpen}
            >
              {summaryOpen ? 'Close unit summary' : 'Generate unit summary report'}
            </Button>
            <span className="text-xs text-ink-2">
              Choose the Zones yourself: every finished audit of this Unit is listed with its
              date, and you can take any of its Zones.
            </span>
          </div>
          {summaryOpen ? <SummaryZonePicker key={unitId} unitId={unitId} /> : null}
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="w-72">
            <Field label="Zone report">
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ZoneReportKind);
                  setNotice(null);
                }}
              >
                {ZONE_REPORT_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-72">
            <Field label="Completed audit">
              <Select
                value={auditId}
                onChange={(event) => {
                  const chosen = completedAudits.find((audit) => audit.id === event.target.value);
                  setAuditId(event.target.value);
                  setAuditZoneId('');
                  // The audit carries the Unit with it, so the history below follows the
                  // report that is about to be queued rather than a Unit left behind.
                  if (chosen && chosen.unitId !== unitId) onUnitChange(chosen.unitId);
                }}
              >
                <option value="">Choose an audit…</option>
                {completedAudits.map((audit) => (
                  <option key={audit.id} value={audit.id}>
                    {auditLabel(audit)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-72">
            <Field label="Zone">
              <Select
                value={auditZoneId}
                onChange={(event) => setAuditZoneId(event.target.value)}
                disabled={!auditId}
              >
                <option value="">Choose a Zone…</option>
                {(auditZones.data?.zones ?? []).map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {generate.error ? <ErrorNotice error={generate.error} /> : null}
        {notice ? <p className="gb-slip">{notice}</p> : null}

        <div className="flex gap-2">
          <Button onClick={() => generate.mutate()} disabled={!auditZoneId || generate.isPending}>
            {generate.isPending ? 'Queuing…' : 'Generate'}
          </Button>
          <PreviewButton disabled={!auditZoneId} body={{ kind, auditZoneId }} />
        </div>
      </div>
    </Card>
  );
}

function VersionHistory({
  snapshots,
  mayGenerate,
  onManageTokens,
}: {
  snapshots: ReportSnapshot[];
  mayGenerate: boolean;
  onManageTokens: (snapshot: ReportSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);

  const regenerate = useMutation({
    mutationFn: (snapshotId: string) =>
      api.post<ReportSnapshot>(`/reports/${snapshotId}/regenerate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports'] }),
  });

  if (snapshots.length === 0) {
    return <p className="px-4 py-6 text-sm text-ink-2">No reports generated yet.</p>;
  }

  return (
    <>
      {error ? <ErrorNotice error={error} /> : null}
      <Table>
        <thead>
          <tr>
            <Th>Kind</Th>
            <Th>Version</Th>
            <Th>Generated</Th>
            <Th>By</Th>
            <Th>Status</Th>
            <Th>Pages</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((snapshot) => (
            <tr key={snapshot.id}>
              <Td>{KIND_LABEL[snapshot.kind]}</Td>
              <Td>
                v{snapshot.version}
                {snapshot.supersedesSnapshotId ? (
                  <span className="ml-1 text-xs text-ink-3">supersedes earlier</span>
                ) : null}
              </Td>
              <Td>{formatDateTime(snapshot.generatedAt)}</Td>
              <Td>{snapshot.generatedByName}</Td>
              <Td>
                <StatusBadge snapshot={snapshot} />
              </Td>
              <Td className="text-right">{snapshot.pageCount ?? '—'}</Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <DownloadButton snapshot={snapshot} onError={setError} />
                  {mayGenerate ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => regenerate.mutate(snapshot.id)}
                        disabled={regenerate.isPending}
                      >
                        Regenerate
                      </Button>
                      <Button variant="secondary" onClick={() => onManageTokens(snapshot)}>
                        Links
                      </Button>
                    </>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function StatusBadge({ snapshot }: { snapshot: ReportSnapshot }) {
  if (snapshot.status === 'READY') return <Badge tone="good">Ready</Badge>;
  if (snapshot.status === 'FAILED') {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="bad">Failed</Badge>
        <span className="text-xs text-ink-2">{snapshot.failedReason}</span>
      </span>
    );
  }
  return <Badge tone="warn">{snapshot.status === 'QUEUED' ? 'Queued' : 'Rendering'}</Badge>;
}

/**
 * The download.
 *
 * The PDF never transits the API: this asks for a short-TTL presigned GET and follows it.
 * The URL is fetched at click time rather than rendered into the row, so a page left open
 * does not accumulate links that outlive their five minutes.
 */
function DownloadButton({
  snapshot,
  onError,
}: {
  snapshot: ReportSnapshot;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      const link = await api.get<ReportDownloadUrl>(`/reports/${snapshot.id}/download-url`);
      window.open(link.url, '_blank', 'noopener');
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={download} disabled={snapshot.status !== 'READY' || busy}>
      {busy ? 'Preparing…' : 'Download'}
    </Button>
  );
}

/**
 * Token management (§8.9, §10.4).
 *
 * The secret is not shown and cannot be: only its hash is stored, and the raw value exists
 * in the link the PDF prints. What this panel offers is what a Super Admin actually needs —
 * seeing that a link has been used, and revoking one that went to the wrong person.
 */
function TokensPanel({ snapshot, onClose }: { snapshot: ReportSnapshot; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<Record<string, string>>({});

  const tokens = useQuery({
    queryKey: ['report-tokens', snapshot.id],
    queryFn: () => api.get<ReportAccessToken[]>(`/reports/${snapshot.id}/tokens`),
  });

  const revoke = useMutation({
    mutationFn: (input: { tokenId: string; reason: string }) =>
      api.post<ReportAccessToken>(
        `/reports/${snapshot.id}/tokens/${input.tokenId}/revoke`,
        { reason: input.reason },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['report-tokens', snapshot.id] }),
  });

  return (
    <Card>
      <CardHeader
        title={`Links — ${KIND_LABEL[snapshot.kind]} v${snapshot.version}`}
        description={
          'One link per nonconformity, printed in the PDF. The link itself is never shown ' +
          'here: only its hash is stored, which is what makes an invalid link and an ' +
          'expired one indistinguishable from outside.'
        }
        action={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      />
      {tokens.isLoading ? <Spinner /> : null}
      {tokens.error ? <ErrorNotice error={tokens.error} /> : null}
      {revoke.error ? <ErrorNotice error={revoke.error} /> : null}
      {tokens.data ? (
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Issued to</Th>
              <Th>Expires</Th>
              <Th>Uses</Th>
              <Th>Last used</Th>
              <Th>State</Th>
              <Th>Revoke</Th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((token) => (
              <tr key={token.id}>
                <Td>
                  {token.zoneCode ? `Zone ${token.zoneCode}` : '—'}
                  {token.questionGlobalOrder ? ` · Q${token.questionGlobalOrder}` : ''}
                </Td>
                <Td>{token.issuedToName ?? '—'}</Td>
                <Td>{formatDate(token.expiresAt)}</Td>
                <Td className="text-right">{token.useCount}</Td>
                <Td>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'Never'}</Td>
                <Td>
                  {token.revokedAt ? (
                    <span className="flex flex-col gap-0.5">
                      <Badge tone="bad">Revoked</Badge>
                      <span className="text-xs text-ink-2">{token.revokeReason}</span>
                    </span>
                  ) : token.active ? (
                    <Badge tone="good">Active</Badge>
                  ) : (
                    <Badge tone="warn">Expired</Badge>
                  )}
                </Td>
                <Td>
                  {token.revokedAt ? null : (
                    <div className="flex gap-1">
                      <input
                        className="w-40 border border-edge px-2 py-1 text-sm"
                        placeholder="Reason"
                        value={reason[token.id] ?? ''}
                        onChange={(event) =>
                          setReason((current) => ({ ...current, [token.id]: event.target.value }))
                        }
                      />
                      <Button
                        variant="danger"
                        disabled={!reason[token.id]?.trim() || revoke.isPending}
                        onClick={() =>
                          revoke.mutate({ tokenId: token.id, reason: reason[token.id]!.trim() })
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

/**
 * `GE · Pune Plant · 16/09/2026` — who audited, where, and when, in that order.
 *
 * The auditor is two letters rather than a full name because the Unit is the thing being
 * scanned for; the date is what separates two audits of the same Unit by the same person,
 * which is exactly the pair a list sorted newest-first puts next to each other.
 */
function auditLabel(audit: Audit): string {
  const initials = audit.auditorName.trim().slice(0, 2).toUpperCase() || '??';
  return `${initials} · ${audit.unitName} · ${formatDate(audit.completedAt)}`;
}

function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Re-exported so a caller can branch on the shape without importing the client. */
export { ApiError };
