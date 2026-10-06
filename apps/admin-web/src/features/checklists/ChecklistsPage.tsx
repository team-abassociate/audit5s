import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChecklistQuestion,
  ChecklistTemplate,
  ChecklistVersion,
  ChecklistVersionDetail,
  Industry,
  Page,
} from '@audit5s/contracts';
import { S_SECTION_ORDER, formatDate } from '@audit5s/domain';
import { SECTION_LABEL } from '@/lib/labels';
import { api } from '@/lib/api';
import {
  Button,
  Card,
  CardHeader,
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
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { RowToggle, rowToggleProps } from '@/features/audits/AuditsPage';
import { ChecklistEditor } from './ChecklistEditor';
import { ImportWizard } from './ImportWizard';
import { downloadTemplate } from './template';
import {
  isWorstCase,
  worstIndustries,
  worstTemplates,
  worstVersionDetail,
  worstVersions,
} from './worst-case';

/**
 * The checklist catalogue: nine departments, each with one published version and its
 * history.
 *
 * Every role may read this — checklists are organization-wide reference data with no Unit
 * in them (D2) — but only a Super Admin sees the import and publish controls, and only
 * because the server says so via `can()`.
 */
export function ChecklistsPage() {
  const { can } = useSession();
  const [importing, setImporting] = useState(false);
  /** The checklist being edited, or `'new'` for the editor's start step. */
  const [editing, setEditing] = useState<ChecklistTemplate | 'new' | null>(null);
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);

  /** `''` is every sector. A template with no industry appears under any of them (0018). */
  const [industryId, setIndustryId] = useState('');

  const industries = useQuery({
    queryKey: ['industries', false],
    queryFn: () =>
      isWorstCase() ? Promise.resolve(worstIndustries(false)) : api.get<Industry[]>('/industries'),
  });

  const templates = useQuery({
    queryKey: ['checklist-templates', industryId],
    queryFn: () =>
      isWorstCase()
        ? Promise.resolve(worstTemplates())
        : api.get<Page<ChecklistTemplate>>(
        `/checklist-templates?limit=200${industryId ? `&industryId=${industryId}` : ''}`,
      ),
  });

  if (importing) {
    return <ImportWizard onFinished={() => setImporting(false)} />;
  }
  if (editing) {
    return (
      <ChecklistEditor
        startFrom={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Checklists"
          description="One template per department, five sections of ten questions each."
          action={
            can('checklist_import', 'upload') ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={downloadTemplate}>
                  Download template
                </Button>
                <Button variant="secondary" onClick={() => setImporting(true)}>
                  Import workbook
                </Button>
                <Button onClick={() => setEditing('new')}>New checklist</Button>
              </div>
            ) : null
          }
        />

        {/* Only worth showing once there is more than one sector to choose between. */}
        {(industries.data?.length ?? 0) > 1 && (
          <div className="flex flex-wrap items-end gap-3 border-b border-edge-soft px-4 py-3">
            <div className="w-64">
              <Field
                label="Industry"
                hint="Templates with no industry are offered to every sector, so they always appear."
              >
                <Select value={industryId} onChange={(event) => setIndustryId(event.target.value)}>
                  <option value="">Every industry</option>
                  {(industries.data ?? []).map((industry) => (
                    <option key={industry.id} value={industry.id}>
                      {industry.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        )}

        {templates.isLoading && <Spinner />}
        {templates.error && (
          <div className="p-4">
            <ErrorNotice error={templates.error} />
          </div>
        )}

        {templates.data && templates.data.data.length === 0 && (
          <p className="px-4 py-6 text-sm text-ink-3">
            No checklists yet.
            {can('checklist_import', 'upload')
              ? ' Write one with New checklist, or import the department workbook.'
              : ''}
          </p>
        )}

        {templates.data && templates.data.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>Industry</Th>
                <Th>Code</Th>
                <Th>Published version</Th>
                <Th>Status</Th>
                <Th>Questions</Th>
              </tr>
            </thead>
            <tbody>
              {templates.data.data.map((template) => {
                const open = openTemplate === template.id;
                const toggle = () => setOpenTemplate(open ? null : template.id);
                const toggleRow = rowToggleProps(toggle);
                return (
                  <Fragment key={template.id}>
                    <tr {...toggleRow} className={cn(toggleRow.className, open && 'gb-row--open')}>
                      <Td className="font-medium">
                        <RowToggle open={open} onClick={toggle}>
                          {template.name}
                        </RowToggle>
                      </Td>
                      <Td>
                        {/* "Every industry" rather than a dash: an unlabelled template is
                            offered everywhere, which is a fact about it, not a gap. */}
                        {template.industries.length > 0 ? (
                          template.industries.map((industry) => industry.name).join(', ')
                        ) : (
                          <span className="text-xs text-ink-3">Every industry</span>
                        )}
                      </Td>
                      <Td className="font-mono text-xs [overflow-wrap:anywhere]">{template.code}</Td>
                      <Td>
                        {template.publishedVersionNumber
                          ? `v${template.publishedVersionNumber}`
                          : '—'}
                      </Td>
                      <Td>
                        {template.publishedVersionId ? (
                          <StatusChip kind="checklist" status="PUBLISHED" />
                        ) : (
                          <StatusChip shape="open">No published version</StatusChip>
                        )}
                      </Td>
                      <Td>50</Td>
                    </tr>
                    {open && (
                      <tr className="gb-row-expand">
                        <td colSpan={6}>
                          <TemplateDetail
                            template={template}
                            onEdit={
                              can('checklist_import', 'upload')
                                ? () => setEditing(template)
                                : undefined
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function TemplateDetail({
  template,
  onEdit,
}: {
  template: ChecklistTemplate;
  onEdit?: () => void;
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();

  const versions = useQuery({
    queryKey: ['checklist-versions', template.id],
    queryFn: () =>
      isWorstCase()
        ? Promise.resolve(worstVersions())
        : api.get<Page<ChecklistVersion>>(`/checklist-versions?templateId=${template.id}&limit=50`),
  });

  const publish = useMutation({
    mutationFn: (versionId: string) =>
      api.post<ChecklistVersion>(`/checklist-versions/${versionId}/publish`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['checklist-versions', template.id] });
      await queryClient.invalidateQueries({ queryKey: ['checklist-templates'] });
    },
  });

  const deactivate = useMutation({
    mutationFn: (versionId: string) =>
      api.post<ChecklistVersion>(`/checklist-versions/${versionId}/deactivate`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['checklist-versions', template.id] });
      await queryClient.invalidateQueries({ queryKey: ['checklist-templates'] });
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="gb-h2">Versions</h3>
          {onEdit && (
            <Button variant="secondary" onClick={onEdit}>
              Edit questions
            </Button>
          )}
        </div>
        {versions.isLoading && <Spinner />}
        {versions.data && (
          <Table>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Status</Th>
                <Th>Published</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {versions.data.data.map((version) => (
                <tr key={version.id}>
                  <Td>v{version.versionNumber}</Td>
                  <Td>
                    <StatusChip kind="checklist" status={version.status} />
                  </Td>
                  <Td>
                    {formatDate(version.publishedAt)}
                  </Td>
                  <Td>
                    <RowActions
                      subject={`${template.name} v${version.versionNumber}`}
                      primary={
                        can('checklist_version', 'publish') && version.status === 'DRAFT' ? (
                          <Button
                            disabled={publish.isPending}
                            onClick={() => publish.mutate(version.id)}
                          >
                            Publish
                          </Button>
                        ) : null
                      }
                      items={
                        can('checklist_version', 'deactivate') && version.status === 'PUBLISHED'
                          ? [
                              {
                                label: 'Deactivate',
                                danger: true,
                                confirm: {
                                  title: `Deactivate ${template.name} v${version.versionNumber}?`,
                                  body: 'New audits can no longer use this checklist until another version is published. Audits already started keep it.',
                                  confirmLabel: 'Deactivate',
                                  pendingLabel: 'Deactivating…',
                                  run: () => deactivate.mutateAsync(version.id),
                                },
                              },
                            ]
                          : []
                      }
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {publish.error && <ErrorNotice error={publish.error} />}
      </div>

      {template.publishedVersionId && (
        <QuestionList versionId={template.publishedVersionId} />
      )}
    </div>
  );
}

function QuestionList({ versionId }: { versionId: string }) {
  const detail = useQuery({
    queryKey: ['checklist-version', versionId],
    queryFn: () =>
      isWorstCase()
        ? Promise.resolve(worstVersionDetail(versionId))
        : api.get<ChecklistVersionDetail>(`/checklist-versions/${versionId}`),
  });

  if (detail.isLoading) return <Spinner />;
  if (!detail.data) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="gb-h2">Questions — v{detail.data.versionNumber}</h3>
        <p className="text-xs text-ink-3">
          The English of a published version never changes. Hindi and Marathi can be corrected
          here.
        </p>
      </div>
      {S_SECTION_ORDER.map((section) => (
        <div key={section}>
          <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">
            {SECTION_LABEL[section]}
          </p>
          <ol className="mt-1 space-y-0.5">
            {detail.data!.questions
              .filter((question) => question.section === section)
              .map((question) => (
                <QuestionRow key={question.id} question={question} />
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

const LANGUAGES = [
  { key: 'hi', label: 'Hindi' },
  { key: 'mr', label: 'Marathi' },
] as const;

/**
 * One question with its Hindi and Marathi beneath it (0036), editable in place by a
 * Super Admin. The English is the record and is never editable here; a translation is
 * keyed by the English, so a fix reaches every department asking the same question.
 */
function QuestionRow({ question }: { question: ChecklistQuestion }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<'hi' | 'mr', string>>({ hi: '', mr: '' });

  const save = useMutation({
    mutationFn: async () => {
      for (const { key } of LANGUAGES) {
        const text = draft[key].trim();
        if (text && text !== (question.translations?.[key] ?? '')) {
          await api.put('/checklist-translations', {
            sourceText: question.text,
            language: key,
            text,
          });
        }
      }
    },
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['checklist-version'] });
    },
  });

  return (
    <li className="border-b border-edge-soft py-1.5 text-sm text-ink-2">
      <div className="flex items-start gap-2">
        <span className="font-mono text-xs text-ink-3">{question.globalOrder}</span>
        <div className="flex-1 space-y-0.5">
          <div className="text-ink">{question.text}</div>
          {!editing &&
            LANGUAGES.map(({ key, label }) => (
              <div key={key} className="text-sm">
                <span className="mr-1 text-xs text-ink-3">{label}:</span>
                {question.translations?.[key] ? (
                  <span lang={key}>{question.translations[key]}</span>
                ) : (
                  <span className="text-xs text-ink-3">not translated</span>
                )}
              </div>
            ))}
          {editing && (
            <div className="space-y-2 pt-1">
              {LANGUAGES.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <Input
                    lang={key}
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </Field>
              ))}
              <div className="flex gap-2">
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
              {save.error && <ErrorNotice error={save.error} />}
            </div>
          )}
        </div>
        {can('checklist_template', 'update') && !editing && (
          <Button
            variant="secondary"
            aria-label={`Edit translation of question ${question.globalOrder}`}
            onClick={() => {
              setDraft({ hi: question.translations?.hi ?? '', mr: question.translations?.mr ?? '' });
              setEditing(true);
            }}
          >
            Edit translation
          </Button>
        )}
      </div>
    </li>
  );
}
