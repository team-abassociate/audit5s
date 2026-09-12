import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Audit,
  type AuditZone,
  type Page,
  type ReportAccessToken,
  type ReportDownloadUrl,
  type ReportKind,
  type ReportSnapshot,
  type Unit,
  type Zone,
} from '@audit5s/contracts';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
  MULTI_ZONE_SUMMARY: 'Multi-Zone summary',
};

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
                <Select value={selectedUnit} onChange={(event) => setUnitId(event.target.value)}>
                  {(units.data?.data ?? []).map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name} ({unit.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          }
        />
      </Card>

      {mayGenerate && selectedUnit ? <GeneratePanel unitId={selectedUnit} /> : null}

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
 * A zone report names one completed audit-Zone; a summary names a **selection** of Zones,
 * with Select All. The selection is stored on the snapshot, so the report is reproducible
 * and its scope unambiguous — which is why this is a real multi-select rather than a
 * "whole Unit" checkbox that would have to be re-interpreted later.
 */
function GeneratePanel({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ReportKind>('INITIAL_ZONE');
  const [auditId, setAuditId] = useState('');
  const [auditZoneId, setAuditZoneId] = useState('');
  const [selectedZoneIds, setSelectedZoneIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const isSummary = kind === 'MULTI_ZONE_SUMMARY';

  const audits = useQuery({
    queryKey: ['audits', 'completed', unitId],
    queryFn: () => api.get<Page<Audit>>(`/audits?limit=200&unitId=${unitId}`),
    enabled: !isSummary,
  });

  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/zones?limit=200&unitId=${unitId}`),
    enabled: isSummary,
  });

  const auditZones = useQuery({
    queryKey: ['audit-zones', auditId],
    queryFn: () => api.get<AuditZone[]>(`/audits/${auditId}/zones`),
    enabled: Boolean(auditId) && !isSummary,
  });

  // Only a completed audit can be reported on (§10.2), so the picker offers no other.
  const completedAudits = useMemo(
    () => (audits.data?.data ?? []).filter((audit) => audit.completedAt !== null),
    [audits.data],
  );

  const generate = useMutation({
    mutationFn: () =>
      api.post<ReportSnapshot>(
        '/reports/generate',
        isSummary ? { kind, unitId, selectedZoneIds } : { kind, auditZoneId },
      ),
    onSuccess: (snapshot) => {
      setNotice(
        `Version ${snapshot.version} queued. It renders in the background; the history ` +
          'updates when it is ready.',
      );
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  const allZoneIds = (zones.data?.data ?? []).map((zone) => zone.id);
  const allSelected = allZoneIds.length > 0 && selectedZoneIds.length === allZoneIds.length;
  const ready = isSummary ? selectedZoneIds.length > 0 : Boolean(auditZoneId);

  return (
    <Card>
      <CardHeader
        title="Generate a report"
        description="Rendering happens in the background; this returns as soon as the payload is frozen."
      />
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-72">
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ReportKind);
                  setAuditZoneId('');
                  setSelectedZoneIds([]);
                  setNotice(null);
                }}
              >
                {(Object.keys(KIND_LABEL) as ReportKind[]).map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {!isSummary ? (
            <>
              <div className="w-72">
                <Field label="Completed audit">
                  <Select
                    value={auditId}
                    onChange={(event) => {
                      setAuditId(event.target.value);
                      setAuditZoneId('');
                    }}
                  >
                    <option value="">Choose an audit…</option>
                    {completedAudits.map((audit) => (
                      <option key={audit.id} value={audit.id}>
                        {audit.auditorName} — {formatDate(audit.completedAt)} ({audit.auditType})
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
                    {(auditZones.data ?? []).map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        Zone {zone.zoneCodeSnapshot} — {zone.zoneNameSnapshot}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </>
          ) : null}
        </div>

        {isSummary ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-800">
                Zones ({selectedZoneIds.length} of {allZoneIds.length} selected)
              </span>
              <Button
                variant="secondary"
                onClick={() => setSelectedZoneIds(allSelected ? [] : allZoneIds)}
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded border border-neutral-200">
              {(zones.data?.data ?? []).map((zone) => (
                <label
                  key={zone.id}
                  className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={selectedZoneIds.includes(zone.id)}
                    onChange={(event) =>
                      setSelectedZoneIds((current) =>
                        event.target.checked
                          ? [...current, zone.id]
                          : current.filter((id) => id !== zone.id),
                      )
                    }
                  />
                  Zone {zone.code} — {zone.name}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-neutral-600">
              Every figure in the summary is computed over the selected Zones only — it is
              never a slice of a Unit-wide number. Each Zone contributes its most recently
              completed audit.
            </p>
          </div>
        ) : null}

        {generate.error ? <ErrorNotice error={generate.error} /> : null}
        {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

        <div className="flex gap-2">
          <Button onClick={() => generate.mutate()} disabled={!ready || generate.isPending}>
            {generate.isPending ? 'Queuing…' : 'Generate'}
          </Button>
          <PreviewButton
            disabled={!ready}
            body={isSummary ? { kind, unitId, selectedZoneIds } : { kind, auditZoneId }}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * `POST /reports/preview` — the HTML, in a new tab, with no snapshot and no link minted.
 *
 * It goes through `fetch` rather than the JSON client because the response is a document
 * rather than a payload, and it is opened as a blob so the browser renders it without this
 * application having to host it.
 */
function PreviewButton({ disabled, body }: { disabled: boolean; body: unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const html = await api.postText('/reports/preview', body);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      // Revoked on a timer rather than immediately: the new tab has to fetch it first.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={open} disabled={disabled || busy}>
        {busy ? 'Rendering…' : 'Preview'}
      </Button>
      {error ? <ErrorNotice error={error} /> : null}
    </>
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
    return <p className="px-4 py-6 text-sm text-neutral-600">No reports generated yet.</p>;
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
                  <span className="ml-1 text-xs text-neutral-500">supersedes earlier</span>
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
        <span className="text-xs text-neutral-600">{snapshot.failedReason}</span>
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
                      <span className="text-xs text-neutral-600">{token.revokeReason}</span>
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
                        className="w-40 rounded border border-neutral-300 px-2 py-1 text-sm"
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

function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Re-exported so a caller can branch on the shape without importing the client. */
export { ApiError };
