import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChecklistTemplate,
  ChecklistVersion,
  ChecklistVersionDetail,
  Industry,
  Page,
} from '@audit5s/contracts';
import { S_SECTION_LABELS, S_SECTION_ORDER } from '@audit5s/domain';
import { api } from '@/lib/api';
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
import { useSession } from '@/lib/session';
import { ImportWizard } from './ImportWizard';

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
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);

  /** `''` is every sector. A template with no industry appears under any of them (0018). */
  const [industryId, setIndustryId] = useState('');

  const industries = useQuery({
    queryKey: ['industries', false],
    queryFn: () => api.get<Industry[]>('/industries'),
  });

  const templates = useQuery({
    queryKey: ['checklist-templates', industryId],
    queryFn: () =>
      api.get<Page<ChecklistTemplate>>(
        `/checklist-templates?limit=200${industryId ? `&industryId=${industryId}` : ''}`,
      ),
  });

  if (importing) {
    return <ImportWizard onFinished={() => setImporting(false)} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Checklists"
          description="One template per department, five sections of ten questions each."
          action={
            can('checklist_import', 'upload') ? (
              <Button onClick={() => setImporting(true)}>Import workbook</Button>
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
              ? ' Import the department workbook to create them.'
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
              {templates.data.data.map((template) => (
                <Fragment key={template.id}>
                  <tr>
                    <Td>
                      <button
                        type="button"
                        className="font-medium text-ink underline"
                        onClick={() =>
                          setOpenTemplate(openTemplate === template.id ? null : template.id)
                        }
                      >
                        {template.name}
                      </button>
                    </Td>
                    <Td>
                      {/* "Every industry" rather than a dash: an unlabelled template is
                          offered everywhere, which is a fact about it, not a gap. */}
                      {template.industryName ?? (
                        <span className="text-xs text-ink-3">Every industry</span>
                      )}
                    </Td>
                    <Td className="font-mono text-xs">{template.code}</Td>
                    <Td>
                      {template.publishedVersionNumber
                        ? `v${template.publishedVersionNumber}`
                        : '—'}
                    </Td>
                    <Td>
                      {template.publishedVersionId ? (
                        <Badge tone="good">Published</Badge>
                      ) : (
                        <Badge tone="warn">No published version</Badge>
                      )}
                    </Td>
                    <Td>50</Td>
                  </tr>
                  {openTemplate === template.id && (
                    <tr>
                      <td colSpan={5} className="bg-board p-0">
                        <TemplateDetail template={template} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function TemplateDetail({ template }: { template: ChecklistTemplate }) {
  const { can } = useSession();
  const queryClient = useQueryClient();

  const versions = useQuery({
    queryKey: ['checklist-versions', template.id],
    queryFn: () =>
      api.get<Page<ChecklistVersion>>(`/checklist-versions?templateId=${template.id}&limit=50`),
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
    <div className="space-y-4 p-4">
      <div>
        <h3 className="gb-h2">Versions</h3>
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
                    <Badge
                      tone={
                        version.status === 'PUBLISHED'
                          ? 'good'
                          : version.status === 'DRAFT'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {version.status}
                    </Badge>
                  </Td>
                  <Td>
                    {version.publishedAt
                      ? new Date(version.publishedAt).toLocaleDateString()
                      : '—'}
                  </Td>
                  <Td>
                    <div className="flex gap-2">
                      {can('checklist_version', 'publish') && version.status === 'DRAFT' && (
                        <Button
                          disabled={publish.isPending}
                          onClick={() => publish.mutate(version.id)}
                        >
                          Publish
                        </Button>
                      )}
                      {can('checklist_version', 'deactivate') &&
                        version.status === 'PUBLISHED' && (
                          <Button
                            variant="secondary"
                            disabled={deactivate.isPending}
                            onClick={() => deactivate.mutate(version.id)}
                          >
                            Deactivate
                          </Button>
                        )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {publish.error && <ErrorNotice error={publish.error} />}
        {deactivate.error && <ErrorNotice error={deactivate.error} />}
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
    queryFn: () => api.get<ChecklistVersionDetail>(`/checklist-versions/${versionId}`),
  });

  if (detail.isLoading) return <Spinner />;
  if (!detail.data) return null;

  return (
    <div className="space-y-3">
      <h3 className="gb-h2">
        Questions — v{detail.data.versionNumber}
        <span className="ml-2 text-xs font-normal text-ink-3">
          published versions never change (CV-1)
        </span>
      </h3>
      {S_SECTION_ORDER.map((section) => (
        <div key={section}>
          <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">
            {S_SECTION_LABELS[section]}
          </p>
          <ol className="mt-1 space-y-0.5">
            {detail.data!.questions
              .filter((question) => question.section === section)
              .map((question) => (
                <li key={question.id} className="text-sm text-ink-2">
                  <span className="mr-2 font-mono text-xs text-ink-3">
                    {question.globalOrder}
                  </span>
                  {question.text}
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
