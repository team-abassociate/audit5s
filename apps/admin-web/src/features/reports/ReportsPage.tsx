import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { ReportSnapshot } from '@audit5s/contracts';
import { api, fetchAll } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { RowToggle, rowToggleProps } from '@/features/audits/AuditsPage';
import { REPORT_EDITION_LABEL } from '@/lib/labels';
import { formatDateTime } from '@audit5s/domain';
import { useUnitScope } from '@/lib/scope';
import { isWorstCase } from '@/features/audit-log/worst-case';
import { worstReports } from './worst-case';
import { ReportPreviewPanel } from './ReportPreviewPanel';
import { NewReportDialog, type NewReportPreset } from './NewReportDialog';
import { loadReportPdf, savePdf } from './report-pdf';
import {
  NO_FILTERS,
  buildLibrary,
  documentTitle,
  filterLibrary,
  isFiltered,
  isInFlight,
  reportName,
  type LibraryFilters,
  type ReportDocument,
  type ReportGroup,
  type StatusFilter,
  type TypeFilter,
} from './report-library';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { StatusChip } from '@/components/Status';

/**
 * Reports (PART 14, Phase 7's Web row): the PDFs issued to clients.
 *
 * The page is a **library**, filed the way the work happened — each audit with the Zone
 * reports issued from it, and each Unit with its summaries — and one **New report** dialog
 * that asks what to issue. It used to be a generation form stacked on a flat log of every
 * render, with a Unit selector at the top that filtered the log, steered one of the two
 * generation forms, was ignored by the other and was changed behind the user's back by it.
 *
 * Nothing is hidden for good (§10.5). A document shows its current version; every earlier
 * version is a click away, so a certification body can still be shown exactly what was
 * issued on a given date. What leaves the list is what a Super Admin took out: a report
 * cancelled before it rendered, or one deleted after (0035).
 */
export function ReportsPage() {
  const { can } = useSession();
  const mayGenerate = can('report', 'generate');

  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [newReport, setNewReport] = useState<NewReportPreset | null>(null);
  const [openEarlier, setOpenEarlier] = useState<ReadonlySet<string>>(new Set());
  const [slip, setSlip] = useState<{ title: string; text: string } | null>(null);
  const [arrivedId, setArrivedId] = useState<string | null>(null);

  // R5: the Unit is the portal's scope, picked in the shell's topbar from every Unit;
  // `null` is "All Units" (organization-wide roles only).
  const scope = useUnitScope();
  const unitId = scope.unitId ?? '';

  const reports = useQuery({
    queryKey: ['reports', 'all', isWorstCase()],
    queryFn: () => (isWorstCase() ? Promise.resolve(worstReports()) : fetchAll<ReportSnapshot>('/reports?limit=200')),
    // A queued report becomes ready in the background; the page notices without a reload.
    refetchInterval: (query) => ((query.state.data ?? []).some(isInFlight) ? 4_000 : 60_000),
  });

  const snapshots = useMemo(() => reports.data ?? [], [reports.data]);
  const library = useMemo(() => buildLibrary(snapshots), [snapshots]);
  const inUnit = useMemo(() => filterLibrary(library, { ...NO_FILTERS, unitId }), [library, unitId]);
  const shown = useMemo(() => filterLibrary(inUnit, filters), [inUnit, filters]);
  const documentCount = shown.reduce((sum, group) => sum + group.documents.length, 0);

  // The rows in the order they are on screen, for ↑ / ↓ in the preview.
  const visible = useMemo(
    () =>
      shown.flatMap((group) =>
        group.documents.flatMap((doc) => (openEarlier.has(doc.key) ? [doc.latest, ...doc.earlier] : [doc.latest])),
      ),
    [shown, openEarlier],
  );
  // A report deleted while open simply leaves the panel, the same as it leaves the list.
  const previewed = snapshots.find((snapshot) => snapshot.id === previewId) ?? null;

  /** A report was queued — by the dialog or by Regenerate. Say so, and show where it is. */
  const announce = (snapshot: ReportSnapshot, how: 'queued' | 'regenerated') => {
    setNewReport(null);
    // A Unit scope or a filter that would hide the new report is changed rather than leaving it invisible.
    if (unitId && snapshot.unitId !== unitId) scope.setUnit(snapshot.unitId);
    // A filter that would hide the new report is cleared rather than leaving it invisible.
    setFilters((current) =>
      filterLibrary(buildLibrary([snapshot]), current).length > 0 ? current : NO_FILTERS,
    );
    setArrivedId(snapshot.id);
    setSlip({
      title: how === 'queued' ? 'Report queued' : 'New version queued',
      text:
        `${reportName(snapshot)} — v${snapshot.version}. It renders in the background and ` +
        'is marked Ready below when it can be downloaded; nothing has been sent to anyone.',
    });
  };

  return (
    <div className="space-y-4">
      {slip ? (
        <div className="gb-slip" role="status">
          <div className="gb-slip-row">
            <div className="min-w-0">
              <b>{slip.title}</b>
              <p>{slip.text}</p>
            </div>
            <Button variant="secondary" onClick={() => setSlip(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <div className={cn(previewed && 'gb-split gb-split--preview')}>
        <Card className="min-w-0">
          <CardHeader
            title="Issued reports"
            description="The PDFs issued to clients, filed under the audit or Unit they cover. Click one to preview it."
            action={
              mayGenerate ? <Button onClick={() => setNewReport({ mode: 'ZONE' })}>New report</Button> : null
            }
          />

          {inUnit.length > 0 ? <FilterBar filters={filters} onChange={setFilters} count={documentCount} /> : null}

          {reports.isLoading ? <Spinner /> : null}
          {reports.error ? <ErrorNotice error={reports.error} /> : null}

          {reports.data && inUnit.length === 0 ? (
            <div className="gb-empty">
              <span>{scope.unit ? `No reports issued for ${scope.unit.name} yet.` : 'No reports issued yet.'}</span>
              {mayGenerate ? (
                <Button onClick={() => setNewReport({ mode: 'ZONE' })}>New report</Button>
              ) : null}
            </div>
          ) : null}

          {reports.data && inUnit.length > 0 && shown.length === 0 ? (
            <div className="gb-empty">
              <span>No report matches these filters.</span>
              <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            </div>
          ) : null}

          {shown.length > 0 ? (
            <Library
              groups={shown}
              compact={previewed !== null}
              mayGenerate={mayGenerate}
              previewId={previewed?.id ?? null}
              arrivedId={arrivedId}
              openEarlier={openEarlier}
              onToggleEarlier={(key) =>
                setOpenEarlier((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              onPreview={(snapshotId) => setPreviewId((open) => (open === snapshotId ? null : snapshotId))}
              onNewReport={setNewReport}
              onRegenerated={(snapshot) => announce(snapshot, 'regenerated')}
            />
          ) : null}
        </Card>

        {previewed ? (
          <ReportPreviewPanel
            snapshot={previewed}
            snapshots={visible}
            kindLabel={REPORT_EDITION_LABEL}
            mayGenerate={mayGenerate}
            onSelect={setPreviewId}
            onClose={() => setPreviewId(null)}
          />
        ) : null}
      </div>

      {mayGenerate ? (
        <NewReportDialog
          open={newReport !== null}
          preset={newReport ?? { mode: 'ZONE' }}
          snapshots={snapshots}
          onClose={() => setNewReport(null)}
          onQueued={(snapshot) => announce(snapshot, 'queued')}
        />
      ) : null}

    </div>
  );
}

// ------------------------------------------------------------------------------ filters

function FilterBar({
  filters,
  onChange,
  count,
}: {
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  count: number;
}) {
  const set = (patch: Partial<LibraryFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="gb-filters" role="search" aria-label="Filter reports">
      <Field label="Type">
        <Select value={filters.type} onChange={(event) => set({ type: event.target.value as TypeFilter })}>
          <option value="ALL">All reports</option>
          <option value="ZONE">Zone reports</option>
          <option value="SUMMARY">Unit summaries</option>
        </Select>
      </Field>
      <Field label="Status">
        <Select
          value={filters.status}
          onChange={(event) => set({ status: event.target.value as StatusFilter })}
        >
          <option value="ALL">Any status</option>
          <option value="READY">Ready</option>
          <option value="IN_PROGRESS">Queued or rendering</option>
          <option value="FAILED">Failed</option>
        </Select>
      </Field>
      <div className="gb-filters-search">
        <Field label="Search">
          <Input
            type="search"
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            placeholder="Zone, Unit or auditor…"
          />
        </Field>
      </div>
      <span className="gb-filters-count" aria-live="polite">
        {count} report{count === 1 ? '' : 's'}
      </span>
      {isFiltered(filters) ? (
        <Button variant="secondary" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------ library

function Library({
  groups,
  compact,
  mayGenerate,
  previewId,
  arrivedId,
  openEarlier,
  onToggleEarlier,
  onPreview,
  onNewReport,
  onRegenerated,
}: {
  groups: ReportGroup[];
  mayGenerate: boolean;
  /** The preview is open beside the list: row actions shrink to their icons. */
  compact: boolean;
  previewId: string | null;
  arrivedId: string | null;
  openEarlier: ReadonlySet<string>;
  onToggleEarlier: (documentKey: string) => void;
  onPreview: (snapshotId: string) => void;
  onNewReport: (preset: NewReportPreset) => void;
  onRegenerated: (snapshot: ReportSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  // The question stays drawn while its dialog fades out, so `open` is separate.
  const [regen, setRegen] = useState<{ snapshot: ReportSnapshot; open: boolean } | null>(null);

  const regenerate = useMutation({
    mutationFn: (snapshotId: string) => api.post<ReportSnapshot>(`/reports/${snapshotId}/regenerate`),
    onSuccess: async (snapshot) => {
      setRegen((current) => current && { ...current, open: false });
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      onRegenerated(snapshot);
    },
  });

  // Cancel is one press: nothing was issued, and the worker simply skips it. Delete asks
  // first, in a dialog naming the version, because it removes the PDF.
  const cancel = useMutation({
    mutationFn: (snapshot: ReportSnapshot) => api.post<ReportSnapshot>(`/reports/${snapshot.id}/cancel`),
    onMutate: () => setError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports'] }),
    onError: setError,
  });
  const remove = async (snapshot: ReportSnapshot) => {
    await api.post<ReportSnapshot>(`/reports/${snapshot.id}/remove`);
    await queryClient.invalidateQueries({ queryKey: ['reports'] });
  };

  // ↑ / ↓ in the preview walk the list; the row being previewed stays in sight.
  useEffect(() => {
    if (!previewId) return;
    document.querySelector(`[data-snapshot="${previewId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [previewId]);

  // A report just queued is brought into view once, when its row first appears.
  const shownArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedId || shownArrival.current === arrivedId) return;
    const row = document.querySelector(`[data-snapshot="${arrivedId}"]`);
    if (!row) return;
    shownArrival.current = arrivedId;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });


  // R3: beside the open preview the list keeps only what tells the rows apart, so the
  // group's button and every row's actions stay inside the column.
  const columns = compact ? 3 : 6;

  const row = (doc: ReportDocument, snapshot: ReportSnapshot, isLatest: boolean, replacedBy?: number) => {
    const open = snapshot.id === previewId;
    const inFlight = isInFlight(snapshot);
    const v = `v${snapshot.version}`;
    return (
      <tr
        key={snapshot.id}
        data-snapshot={snapshot.id}
        onClick={rowToggleProps(() => onPreview(snapshot.id)).onClick}
        className={cn(
          'cursor-pointer',
          !isLatest && 'gb-row--earlier',
          open && 'gb-row--open',
          snapshot.id === arrivedId && 'gb-row--target',
        )}
      >
        <Td>
          {isLatest ? (
            <>
              <RowToggle open={open} onClick={() => onPreview(snapshot.id)}>
                <span className="gb-doc-title">{documentTitle(snapshot)}</span>
              </RowToggle>
              {doc.earlier.length > 0 ? (
                <div>
                  <button
                    type="button"
                    className="gb-earlier-toggle"
                    aria-expanded={openEarlier.has(doc.key)}
                    onClick={() => onToggleEarlier(doc.key)}
                  >
                    {openEarlier.has(doc.key)
                      ? 'Hide earlier versions'
                      : `${doc.earlier.length} earlier version${doc.earlier.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <RowToggle open={open} onClick={() => onPreview(snapshot.id)}>
              Replaced by v{replacedBy}
            </RowToggle>
          )}
        </Td>
        {compact ? null : (
          <>
            <Td>
              <Badge>{REPORT_EDITION_LABEL[snapshot.kind]}</Badge>
            </Td>
            <Td className="gb-data">{v}</Td>
          </>
        )}
        <Td>
          <StatusBadge snapshot={snapshot} />
        </Td>
        {compact ? null : (
          <Td className="gb-data">
            <span title={`Generated by ${snapshot.generatedByName}`}>{formatDateTime(snapshot.generatedAt)}</span>
          </Td>
        )}
        <Td>
          {/* R4: Download is the row's one visible action; the rest wait behind "⋯". */}
          <RowActions
            subject={`${documentTitle(snapshot)} ${v}`}
            primary={<DownloadButton snapshot={snapshot} compact={compact} onError={setError} />}
            items={
              mayGenerate
                ? [
                    ...(isLatest
                      ? [
                          {
                            label: 'Regenerate',
                            disabled: inFlight,
                            hint: inFlight ? 'This version is still rendering.' : 'Issue a new version from the current data.',
                            onSelect: () => {
                              regenerate.reset();
                              setRegen({ snapshot, open: true });
                            },
                          },
                        ]
                      : []),
                    inFlight
                      ? {
                          label: cancel.isPending ? 'Cancelling…' : 'Cancel rendering',
                          disabled: cancel.isPending,
                          hint: 'Stop it before it renders. Nothing was issued.',
                          onSelect: () => cancel.mutate(snapshot),
                        }
                      : {
                          label: `Delete ${v}`,
                          danger: true as const,
                          confirm: {
                            title: `Delete ${v} of ${documentTitle(snapshot)}?`,
                            body: 'Its PDF is deleted for good and it leaves this list; the record that it was issued is kept.',
                            confirmLabel: `Delete ${v}`,
                            pendingLabel: 'Deleting…',
                            run: () => remove(snapshot),
                          },
                        },
                  ]
                : []
            }
          />
        </Td>
      </tr>
    );
  };

  return (
    <div className={cn(compact && 'gb-library--compact')}>
      {error ? <ErrorNotice error={error} /> : null}
      <Table>
        <thead>
          <tr>
            <Th>Report</Th>
            {compact ? null : (
              <>
                <Th>Edition</Th>
                <Th>Version</Th>
              </>
            )}
            <Th>Status</Th>
            {compact ? null : <Th>Generated</Th>}
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key}>
              <tr className="gb-group">
                <Td colSpan={columns}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="gb-group-title">{group.unitName}</span>
                      <span className="gb-group-meta">{groupMeta(group)}</span>
                    </div>
                    {mayGenerate ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          onNewReport(
                            group.kind === 'AUDIT'
                              ? { mode: 'ZONE', auditId: group.documents[0]?.latest.auditId ?? undefined }
                              : { mode: 'SUMMARY', unitId: group.unitId },
                          )
                        }
                      >
                        {group.kind === 'AUDIT' ? 'Report another Zone' : 'New summary'}
                      </Button>
                    ) : null}
                  </div>
                </Td>
              </tr>
              {group.documents.map((doc) => (
                <Fragment key={doc.key}>
                  {row(doc, doc.latest, true)}
                  {openEarlier.has(doc.key)
                    ? doc.earlier.map((snapshot, index) =>
                        row(doc, snapshot, false, (doc.earlier[index - 1] ?? doc.latest).version),
                      )
                    : null}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </Table>
      {regen ? (
        <ConfirmDialog
          open={regen.open}
          tone="primary"
          title={`Regenerate ${documentTitle(regen.snapshot)}?`}
          confirmLabel="Regenerate"
          pendingLabel="Queuing…"
          cancelLabel={`Keep v${regen.snapshot.version}`}
          pending={regenerate.isPending}
          error={regenerate.error}
          onCancel={() => setRegen({ ...regen, open: false })}
          onConfirm={() => regenerate.mutate(regen.snapshot.id)}
        >
          It is issued from the current data as a new version; v{regen.snapshot.version} stays in the history.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function groupMeta(group: ReportGroup): string {
  if (group.kind === 'SUMMARIES') {
    return `Unit summaries · ${group.documents.length}`;
  }
  const who = group.auditorNames.length > 0 ? ` · ${group.auditorNames.join(', ')}` : '';
  return `Audit finished ${group.auditedAt ? formatDateTime(group.auditedAt) : 'on an unknown date'}${who}`;
}

function StatusBadge({ snapshot }: { snapshot: ReportSnapshot }) {
  if (snapshot.status === 'READY') return <StatusChip shape="done">Ready</StatusChip>;
  if (snapshot.status === 'FAILED') {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="bad">Failed</Badge>
        <span className="text-xs text-ink-2">{snapshot.failedReason}</span>
      </span>
    );
  }
  if (snapshot.status === 'CANCELLED') return <StatusChip shape="ended">Cancelled</StatusChip>;
  if (snapshot.status === 'REMOVED') return <StatusChip shape="ended">Deleted</StatusChip>;
  return (
    <StatusChip shape="progress">{snapshot.status === 'QUEUED' ? 'Queued' : 'Rendering'}</StatusChip>
  );
}

/**
 * The download.
 *
 * The PDF never transits the API: this asks for a short-TTL presigned GET, fetches the bytes
 * and saves them under the report's own name (`Unit - Zone - kind - date - vN.pdf`). The URL
 * is minted at click time rather than rendered into the row, so a page left open does not
 * accumulate links that outlive their five minutes; a report already open in the preview is
 * saved from the bytes it holds.
 */
/** Drawn like the preview toolbar's icons: a 2px square-capped stroke in `currentColor`. */
const ROW_ICON = {
  size: 14,
  strokeWidth: 2,
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
  'aria-hidden': true,
  focusable: false,
} as const;

function DownloadButton({
  snapshot,
  compact,
  onError,
}: {
  snapshot: ReportSnapshot;
  compact: boolean;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      savePdf(await loadReportPdf(queryClient, snapshot));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  const label = busy ? 'Preparing…' : 'Download';
  const hint = snapshot.status === 'READY' ? 'Save the PDF under its report name.' : 'Available once the report is ready.';
  // Icon and word while the list has the page; the icon alone beside the preview, the word
  // kept as its accessible name and tooltip.
  return (
    <Button
      variant="secondary"
      className={cn('gb-btn--sm gb-btn--act', compact && 'gb-btn--act-icon')}
      disabled={snapshot.status !== 'READY' || busy}
      aria-label={compact ? label : undefined}
      title={`${label} — ${hint}`}
      onClick={() => void download()}
    >
      <Download {...ROW_ICON} />
      {compact ? null : <span>{label}</span>}
    </Button>
  );
}
