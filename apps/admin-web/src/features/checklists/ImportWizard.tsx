import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ChecklistImportJob,
  ChecklistImportPreview,
  ChecklistImportSheet,
  ChecklistSheetDiff,
  CommitChecklistImportResponse,
} from '@audit5s/contracts';
import { S_SECTION_LABELS } from '@audit5s/domain';
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

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return uploadWorkbook(form);
    },
    onSuccess: async (created) => {
      setError(null);
      setJob(created);
      setStep('validating');
      await validate(created.id);
    },
    onError: setError,
  });

  /**
   * Validation runs on `worker-general`, so the API answers 202 and this polls. The delay
   * is the honest shape of the operation: parsing a workbook in the request would be the
   * shortcut §12.8 rules out.
   */
  async function validate(jobId: string): Promise<void> {
    try {
      await api.post(`/checklist-imports/${jobId}/validate`);
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
            One sheet per department. A sheet is read as a checklist only when cell A1 reads
            <span className="font-mono"> 5S AUDIT CHECK SHEET – …</span>; anything else is skipped.
          </p>
          <input
            type="file"
            accept=".xlsx"
            className="block text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
          {upload.isPending && <Spinner label="Uploading…" />}
        </div>
      )}

      {step === 'validating' && <Spinner label="Reading the workbook…" />}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
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
            Imported and published. Devices pick the new version up on their next catalogue sync.
          </p>
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

function PreviewStep({
  preview,
  selected,
  onToggle,
  onCommit,
  committing,
}: {
  preview: ChecklistImportPreview;
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
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody>
          {preview.sheets.map((sheet) => {
            const diff = preview.diffs.find((candidate) => candidate.sheetId === sheet.id);
            const blocked = sheet.severity === 'ERROR' || sheet.duplicateIsPublished;
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
                  <Td>
                    <SheetVerdict sheet={sheet} />
                  </Td>
                </tr>
                {openSheet === sheet.id && diff && (
                  <tr>
                    <td colSpan={6} className="bg-board p-0">
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
            : `Commit and publish ${selected.size} checklist${selected.size === 1 ? '' : 's'}`}
        </Button>
        <span className="text-xs text-ink-3">
          {committable.length === 0
            ? 'Nothing to import — every sheet either has errors or matches the published checklist.'
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
                {S_SECTION_LABELS[entry.section]}
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

function committableSheets(preview: ChecklistImportPreview): ChecklistImportSheet[] {
  return preview.sheets.filter(
    (sheet) => sheet.severity !== 'ERROR' && !sheet.duplicateIsPublished,
  );
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
