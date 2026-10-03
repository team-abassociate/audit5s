import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChecklistImportJob,
  ChecklistImportPreview,
  ChecklistImportSheet,
  ChecklistSheetDiff,
  CommitChecklistImportResponse,
  Industry,
} from '@audit5s/contracts';
import { SECTION_LABEL } from '@/lib/labels';
import { ApiError, api, loadSession } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNotice,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { downloadTemplate } from './template';

/**
 * The checklist import wizard: upload → validation report → side-by-side diff → commit.
 *
 * The four steps mirror §8.5's stages exactly, and the wording is deliberate about what
 * has happened: until Commit, **nothing has been written**. A Super Admin who uploads the
 * wrong file can close this page and leave no trace but an import job.
 */
type Step = 'upload' | 'validating' | 'preview' | 'committed';

export function ImportWizard({ onFinished }: { onFinished: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('upload');
  const [job, setJob] = useState<ChecklistImportJob | null>(null);
  const [preview, setPreview] = useState<ChecklistImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  /** The industries this workbook is for (0042). `null` is every industry. */
  const [industryIds, setIndustryIds] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const noIndustryTicked = industryIds !== null && industryIds.length === 0;
  const pick = (file: File | undefined) => {
    if (file && !noIndustryTicked) upload.mutate({ file, industryIds: industryIds ?? [] });
  };

  const industries = useQuery({
    queryKey: ['industries', false],
    queryFn: () => api.get<Industry[]>('/industries'),
  });

  const upload = useMutation({
    mutationFn: async ({ file }: { file: File; industryIds: string[] }) => {
      const form = new FormData();
      form.append('file', file);
      return uploadWorkbook(form);
    },
    onSuccess: async (created, { industryIds: chosen }) => {
      setError(null);
      setJob(created);
      setStep('validating');
      await validate(created.id, chosen);
    },
    onError: setError,
  });

  /**
   * Validation runs on `worker-general`, so the API answers 202 and this polls. The delay
   * is the honest shape of the operation: parsing a workbook in the request would be the
   * shortcut §12.8 rules out.
   */
  async function validate(jobId: string, chosen: string[]): Promise<void> {
    try {
      await api.post(`/checklist-imports/${jobId}/validate`, { industryIds: chosen });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const current = await api.get<ChecklistImportJob>(`/checklist-imports/${jobId}`);
        if (current.status === 'VALIDATING' || current.status === 'UPLOADED') continue;

        const result = await api.get<ChecklistImportPreview>(
          `/checklist-imports/${jobId}/preview`,
        );
        setJob(current);
        setPreview(result);
        setSelected(new Set(committableSheets(result).map((sheet) => sheet.id)));
        setStep('preview');
        return;
      }
      setError(new Error('The import is taking longer than expected. Reload to check on it.'));
    } catch (caught) {
      setError(caught);
      setStep('preview');
    }
  }

  const commit = useMutation({
    mutationFn: () =>
      api.post<CommitChecklistImportResponse>(`/checklist-imports/${job!.id}/commit`, {
        sheetIds: [...selected],
        publish: true,
      }),
    onSuccess: async () => {
      setError(null);
      setStep('committed');
      await queryClient.invalidateQueries({ queryKey: ['checklist-templates'] });
      await queryClient.invalidateQueries({ queryKey: ['checklist-versions'] });
    },
    onError: setError,
  });

  return (
    <Card>
      <CardHeader
        title="Import department checklists"
        description="Upload the workbook, review what changed, then commit. Nothing is saved until you commit."
        action={
          <Button variant="secondary" onClick={onFinished}>
            Close
          </Button>
        }
      />

      <Steps current={step} />

      {error !== null && error !== undefined && (
        <div className="p-4">
          <ErrorNotice error={error} />
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-3 p-4">
          <p className="text-sm text-ink-2">
            Start from the{' '}
            <button type="button" className="text-ink underline" onClick={downloadTemplate}>
              blank template
            </button>
            , or upload the department workbook you already have: one sheet per department, 50
            Check Points each, with optional Hindi and Marathi columns. Auditors who choose those
            languages see them above the English; a blank cell keeps the translation already
            saved. Sheets that are not checklists are skipped.
          </p>
          <IndustryChoice
            industries={industries.data ?? []}
            chosen={industryIds}
            onChange={setIndustryIds}
          />
          <label
            className={cn(
              'flex cursor-pointer flex-col items-start gap-1 border-[1.5px] border-dashed border-edge bg-tile-2 px-4 py-5',
              'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[var(--accent)]',
              dragging && 'border-solid bg-tile',
              (noIndustryTicked || upload.isPending) && 'cursor-not-allowed border-edge-soft',
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              pick(event.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              accept=".xlsx"
              className="sr-only"
              disabled={noIndustryTicked || upload.isPending}
              onChange={(event) => pick(event.target.files?.[0])}
            />
            <span className="font-semibold text-ink">Choose the workbook (.xlsx)</span>
            <span className="text-xs text-ink-3">
              {noIndustryTicked
                ? 'Tick at least one industry above, or choose Every industry.'
                : 'or drop it here. Nothing is saved until you commit.'}
            </span>
          </label>
          {upload.isPending && <Spinner label="Uploading…" />}
        </div>
      )}

      {step === 'validating' && <Spinner label="Reading the workbook…" />}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          industries={industries.data ?? []}
          selected={selected}
          onToggle={(sheetId) =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(sheetId)) next.delete(sheetId);
              else next.add(sheetId);
              return next;
            })
          }
          onCommit={() => commit.mutate()}
          committing={commit.isPending}
        />
      )}

      {step === 'committed' && (
        <div className="space-y-3 p-4">
          <p className="text-sm font-medium text-ink">
            {commit.data && commit.data.versions.length === 0
              ? 'Translations saved.'
              : 'Imported and published.'}{' '}
            Devices pick the change up on their next catalogue sync.
          </p>
          {commit.data && commit.data.translationsSaved > 0 && (
            <p className="text-sm text-ink-2">
              {commit.data.translationsSaved} Hindi and Marathi translation
              {commit.data.translationsSaved === 1 ? '' : 's'} saved.
            </p>
          )}
          <Button onClick={onFinished}>Done</Button>
        </div>
      )}
    </Card>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'upload', label: '1 · Upload' },
    { key: 'validating', label: '2 · Validate' },
    { key: 'preview', label: '3 · Review the diff' },
    { key: 'committed', label: '4 · Commit' },
  ];
  const index = steps.findIndex((step) => step.key === current);

  return (
    <ol className="flex gap-4 border-b border-edge-soft px-4 py-2 text-xs">
      {steps.map((step, position) => (
        <li
          key={step.key}
          className={
            position === index
              ? 'font-semibold text-ink'
              : position < index
                ? 'text-ink-3'
                : 'text-ink-3'
          }
        >
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * Which industries the workbook is for (0042), chosen before upload because the preview's
 * match depends on it: a sheet updates an existing checklist only when it was imported for
 * exactly the same industries, and anything else becomes a new checklist.
 */
function IndustryChoice({
  industries,
  chosen,
  onChange,
}: {
  industries: Industry[];
  chosen: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  if (industries.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="gb-label mb-2">Which industries is this workbook for?</legend>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="radio"
          name="import-industries"
          checked={chosen === null}
          onChange={() => onChange(null)}
        />
        Every industry
      </label>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="radio"
          name="import-industries"
          checked={chosen !== null}
          onChange={() => onChange(chosen ?? [])}
        />
        Only these industries
      </label>
      {chosen !== null && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 pl-6">
          {industries.map((industry) => (
            <label key={industry.id} className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={chosen.includes(industry.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, industry.id]
                      : chosen.filter((id) => id !== industry.id),
                  )
                }
              />
              {industry.name}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-3">
        A sheet updates an existing checklist only if that checklist has the same name and
        exactly these industries; otherwise it becomes a new checklist, so another
        industry&apos;s questions never change.
      </p>
    </fieldset>
  );
}

/** "Hospital, Clinic", or "every industry" for an empty list. */
function industryNames(ids: readonly string[], industries: readonly Industry[]): string {
  if (ids.length === 0) return 'every industry';
  return ids
    .map((id) => industries.find((industry) => industry.id === id)?.name ?? 'an archived industry')
    .join(', ');
}

function PreviewStep({
  preview,
  industries,
  selected,
  onToggle,
  onCommit,
  committing,
}: {
  preview: ChecklistImportPreview;
  industries: Industry[];
  selected: Set<string>;
  onToggle: (sheetId: string) => void;
  onCommit: () => void;
  committing: boolean;
}) {
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  const committable = committableSheets(preview);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={preview.job.errorCount > 0 ? 'bad' : 'good'}>
          {preview.job.errorCount} error{preview.job.errorCount === 1 ? '' : 's'}
        </Badge>
        <Badge tone={preview.job.warningCount > 0 ? 'warn' : 'neutral'}>
          {preview.job.warningCount} warning{preview.job.warningCount === 1 ? '' : 's'}
        </Badge>
        <span className="text-ink-3">
          {preview.job.sheetCount} checklist sheet{preview.job.sheetCount === 1 ? '' : 's'} ·{' '}
          {preview.job.parsedRowCount} rows read
        </span>
        {preview.job.errorReportObjectKey && (
          <a
            className="text-ink underline"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              void downloadErrorReport(preview.job.id);
            }}
          >
            Download the annotated workbook
          </a>
        )}
      </div>

      <p className="text-sm text-ink-2">
        For <span className="font-medium text-ink">{industryNames(preview.job.industryIds, industries)}</span>.
        Sheets marked <span className="text-xs text-ink-3">new</span> become new checklists.
      </p>

      {preview.skippedSheets.length > 0 && (
        <p className="text-xs text-ink-3">
          Skipped: {preview.skippedSheets.map((sheet) => sheet.name).join(', ')} — not checklists.
        </p>
      )}

      <Table>
        <thead>
          <tr>
            <Th>Import</Th>
            <Th>Sheet</Th>
            <Th>Department</Th>
            <Th>Questions</Th>
            <Th>Change</Th>
            <Th>Translations</Th>
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody>
          {preview.sheets.map((sheet) => {
            const diff = preview.diffs.find((candidate) => candidate.sheetId === sheet.id);
            const blocked = !isCommittable(sheet);
            return (
              <Fragment key={sheet.id}>
                <tr>
                  <Td>
                    <input
                      type="checkbox"
                      disabled={blocked}
                      checked={selected.has(sheet.id)}
                      onChange={() => onToggle(sheet.id)}
                    />
                  </Td>
                  <Td>{sheet.sheetName}</Td>
                  <Td>
                    {sheet.templateCode}
                    {sheet.templateId === null && (
                      <span className="ml-2 text-xs text-ink-3">new</span>
                    )}
                  </Td>
                  <Td>{sheet.questionCount}</Td>
                  <Td>
                    {diff ? (
                      <button
                        type="button"
                        className="text-ink underline"
                        onClick={() => setOpenSheet(openSheet === sheet.id ? null : sheet.id)}
                      >
                        {diff.currentVersionNumber === null
                          ? `${diff.added} new`
                          : `${diff.changed} changed · ${diff.added} added · ${diff.removed} removed`}
                      </button>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {hasTranslations(sheet)
                      ? `Hindi ${sheet.translationCounts.hi} · Marathi ${sheet.translationCounts.mr}`
                      : '—'}
                  </Td>
                  <Td>
                    <SheetVerdict sheet={sheet} />
                  </Td>
                </tr>
                {openSheet === sheet.id && diff && (
                  <tr>
                    <td colSpan={7} className="bg-board p-0">
                      <SideBySideDiff diff={diff} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>

      <div className="flex items-center gap-3">
        <Button disabled={committing || selected.size === 0} onClick={onCommit}>
          {committing
            ? 'Committing…'
            : `Commit ${selected.size} sheet${selected.size === 1 ? '' : 's'}`}
        </Button>
        <span className="text-xs text-ink-3">
          {committable.length === 0
            ? 'Nothing to import — every sheet either has errors or matches the published checklist, translations included.'
            : 'Nothing has been written yet.'}
        </span>
      </div>
    </div>
  );
}

function SheetVerdict({ sheet }: { sheet: ChecklistImportSheet }) {
  if (sheet.severity === 'ERROR') {
    return (
      <div className="space-y-1">
        <Badge tone="bad">Cannot import</Badge>
        {sheet.messages.map((message) => (
          <p key={message} className="text-xs text-ink-2">
            {message}
          </p>
        ))}
      </div>
    );
  }
  if (sheet.duplicateIsPublished && hasTranslations(sheet)) {
    return (
      <div className="space-y-1">
        <Badge tone="neutral">Translations only</Badge>
        <p className="text-xs text-ink-2">
          The English matches the published checklist, so no new version is made. Committing
          saves the translations.
        </p>
      </div>
    );
  }
  if (sheet.duplicateIsPublished) {
    return <Badge tone="neutral">No changes</Badge>;
  }
  if (sheet.messages.length > 0) {
    return (
      <div className="space-y-1">
        <Badge tone="warn">Review</Badge>
        {sheet.messages.map((message) => (
          <p key={message} className="text-xs text-ink-2">
            {message}
          </p>
        ))}
      </div>
    );
  }
  return <Badge tone="good">Ready</Badge>;
}

/**
 * The side-by-side diff §14's Web row calls for: the published wording on the left, what
 * the workbook would replace it with on the right, matched by position so a reworded
 * question reads as one change rather than as a delete plus an add.
 */
function SideBySideDiff({ diff }: { diff: ChecklistSheetDiff }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const entries = showUnchanged
    ? diff.entries
    : diff.entries.filter((entry) => entry.change !== 'UNCHANGED');

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-3">
          {diff.currentVersionNumber === null
            ? 'No published version yet — every question is new.'
            : `Against published version ${diff.currentVersionNumber}.`}
        </p>
        <button
          type="button"
          className="text-xs text-ink underline"
          onClick={() => setShowUnchanged((open) => !open)}
        >
          {showUnchanged ? 'Hide unchanged' : `Show all ${diff.entries.length}`}
        </button>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Section</Th>
            <Th>#</Th>
            <Th>Currently published</Th>
            <Th>In this workbook</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.section}-${entry.orderInSection}`}>
              <Td className="whitespace-nowrap text-xs text-ink-3">
                {SECTION_LABEL[entry.section]}
              </Td>
              <Td>{entry.orderInSection}</Td>
              <Td
                className={
                  entry.change === 'CHANGED' || entry.change === 'REMOVED'
                    ? 'bg-tile-2'
                    : undefined
                }
              >
                {entry.currentText ?? <span className="text-ink-3">—</span>}
              </Td>
              <Td
                className={
                  entry.change === 'CHANGED' || entry.change === 'ADDED'
                    ? 'bg-tile-2'
                    : undefined
                }
              >
                {entry.incomingText ?? <span className="text-ink-3">—</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function hasTranslations(sheet: ChecklistImportSheet): boolean {
  return sheet.translationCounts.hi + sheet.translationCounts.mr > 0;
}

/**
 * A sheet that would make a new version, or one whose English matches the published
 * checklist but carries translations to save. A sheet identical in both has nothing to add.
 */
function isCommittable(sheet: ChecklistImportSheet): boolean {
  if (sheet.severity === 'ERROR') return false;
  return !sheet.duplicateIsPublished || hasTranslations(sheet);
}

function committableSheets(preview: ChecklistImportPreview): ChecklistImportSheet[] {
  return preview.sheets.filter(isCommittable);
}

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

/**
 * The two requests that cannot go through `api`: one sends `FormData` (which must not
 * carry a JSON content type) and one downloads a binary. Both still carry the session
 * token, and both surface the server's problem document.
 */
async function uploadWorkbook(form: FormData): Promise<ChecklistImportJob> {
  const session = loadSession();
  const response = await fetch(`${BASE_URL}/checklist-imports`, {
    method: 'POST',
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
    body: form,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (payload as ApiError['problem']) ?? {
        type: 'about:blank',
        title: response.statusText,
        status: response.status,
        code: 'INTERNAL_ERROR',
        requestId: 'unknown',
      },
    );
  }
  return payload as ChecklistImportJob;
}

async function downloadErrorReport(jobId: string): Promise<void> {
  const session = loadSession();
  const response = await fetch(`${BASE_URL}/checklist-imports/${jobId}/error-report`, {
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
  });
  if (!response.ok) return;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `import-${jobId}-errors.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}
