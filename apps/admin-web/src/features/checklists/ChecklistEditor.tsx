import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ChecklistTemplate,
  ChecklistVersion,
  ChecklistVersionDetail,
  Industry,
  Page,
} from '@audit5s/contracts';
import {
  MAX_QUESTION_TEXT_LENGTH,
  MAX_TRANSLATION_TEXT_LENGTH,
  QUESTIONS_PER_SECTION,
  S_SECTION_ORDER,
  templateCodeForSheet,
} from '@audit5s/domain';
import { SECTION_LABEL } from '@/lib/labels';
import { api } from '@/lib/api';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
} from '@/components/ui';
import { ImportWizard, IndustryChoice, Steps, type WizardSource } from './ImportWizard';
import { checkDraft, draftWorkbook, type ChecklistDraft } from './template';

/**
 * The in-app checklist editor (D13, CL1): start blank or from a copy of a checklist, write
 * the 50 questions with their Hindi and Marathi, then review and commit.
 *
 * It writes nothing itself. Review turns the draft into the workbook a person could have
 * uploaded and hands it to the import wizard, so validation, the published-version diff,
 * the new-version-or-new-checklist match (R-44), draft or publish, idempotency and the
 * audit log are the import's, unchanged. A published version is never edited: committing
 * makes the next version, exactly as re-importing would.
 */
type Stage = 'start' | 'write' | 'review';

const BLANK: ChecklistDraft['questions'][number] = { text: '', hi: '', mr: '' };
const blankQuestions = () =>
  Array.from({ length: S_SECTION_ORDER.length * QUESTIONS_PER_SECTION }, () => ({ ...BLANK }));

export function ChecklistEditor({
  startFrom,
  onClose,
}: {
  /** Opened from a checklist's own "Edit questions": skip the start step and copy it. */
  startFrom?: ChecklistTemplate;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>('start');
  const [fromId, setFromId] = useState('');
  const [draft, setDraft] = useState<ChecklistDraft>({ name: '', questions: blankQuestions() });
  /** The copied checklist's questions as loaded, to flag a translation left behind its English. */
  const [original, setOriginal] = useState<ChecklistDraft['questions'] | null>(null);
  /** `null` is every industry, as on the import. */
  const [industryIds, setIndustryIds] = useState<string[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [source, setSource] = useState<WizardSource | null>(null);

  const templates = useQuery({
    queryKey: ['checklist-templates', ''],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const industries = useQuery({
    queryKey: ['industries', false],
    queryFn: () => api.get<Industry[]>('/industries'),
  });

  const load = useMutation({
    mutationFn: async (template: ChecklistTemplate | null) => {
      if (!template) return null;
      return { template, questions: await questionsOf(template) };
    },
    onSuccess: (copied) => {
      if (copied) {
        setDraft({ name: copied.template.name, questions: copied.questions });
        setOriginal(copied.questions);
        // The same industries, so committing makes the next version of this checklist
        // rather than a second one beside it (R-44).
        const ids = copied.template.industries.map((industry) => industry.id);
        setIndustryIds(ids.length > 0 ? ids : null);
      }
      setStage('write');
    },
  });

  const opened = useRef(false);
  useEffect(() => {
    if (!startFrom || opened.current) return;
    opened.current = true;
    load.mutate(startFrom);
  }, [startFrom, load]);

  const check = useMemo(() => checkDraft(draft), [draft]);
  // A translation is keyed by its English (0036): change the English and the copied Hindi
  // or Marathi would be saved as the new question's wording unless someone checks it.
  const staleTranslation = (index: number) => {
    const was = original?.[index];
    const now = draft.questions[index];
    if (!was || !now || now.text.trim() === was.text.trim()) return null;
    const behind = [
      now.hi !== '' && now.hi === was.hi && 'Hindi',
      now.mr !== '' && now.mr === was.mr && 'Marathi',
    ].filter(Boolean);
    return behind.length > 0
      ? `The English changed: check the ${behind.join(' and ')} still says the same`
      : null;
  };

  // A browser refresh or a closed tab would lose fifty questions without a word.
  useEffect(() => {
    if (!dirty || stage === 'review') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, stage]);
  const invalid = check.name !== null || check.errors.some(Boolean);
  const noIndustryTicked = industryIds !== null && industryIds.length === 0;
  const match = useMemo(
    () => matchFor(draft.name, industryIds ?? [], templates.data?.data ?? []),
    [draft.name, industryIds, templates.data],
  );

  const edit = (index: number, field: keyof ChecklistDraft['questions'][number], value: string) => {
    setDirty(true);
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, at) =>
        at === index ? { ...question, [field]: value } : question,
      ),
    }));
  };

  const review = () => {
    if (invalid || noIndustryTicked) {
      setShowErrors(true);
      const firstQuestion = check.errors.findIndex(Boolean);
      document
        .getElementById(check.name !== null ? 'checklist-name' : `question-${firstQuestion + 1}-en`)
        ?.focus();
      return;
    }
    setSource({
      file: draftWorkbook({ ...draft, name: draft.name.trim() }),
      industryIds: industryIds ?? [],
      key: crypto.randomUUID(),
    });
    setStage('review');
  };

  const close = () => (dirty ? setDiscarding(true) : onClose());

  if (stage === 'review' && source) {
    return (
      <ImportWizard source={source} onClose={() => setStage('write')} onFinished={onClose} />
    );
  }

  return (
    <Card>
      <CardHeader
        title={startFrom ? `Edit ${startFrom.name}` : 'New checklist'}
        description="Five sections of ten questions, in English, with optional Hindi and Marathi. Nothing is saved until you review and commit."
        action={
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        }
      />
      <Steps current="upload" first="1 · Write" />

      {stage === 'start' && (
        <div className="max-w-xl space-y-3 p-4">
          {startFrom || load.isPending ? (
            <Spinner label="Loading the checklist…" />
          ) : (
            <>
              <Field
                label="Start from"
                hint="A copy keeps the name and industries, so committing makes its next version. Rename it, or change its industries, to make a separate checklist."
              >
                <Select value={fromId} onChange={(event) => setFromId(event.target.value)}>
                  <option value="">A blank checklist</option>
                  {(templates.data?.data ?? []).map((template) => (
                    <option key={template.id} value={template.id}>
                      A copy of {template.name}
                      {template.industries.length > 0
                        ? ` (${template.industries.map((industry) => industry.name).join(', ')})`
                        : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                onClick={() =>
                  load.mutate(templates.data?.data.find((template) => template.id === fromId) ?? null)
                }
              >
                Continue
              </Button>
            </>
          )}
          {load.error && <ErrorNotice error={load.error} />}
        </div>
      )}

      {stage === 'write' && (
        <div className="space-y-6 p-4">
          <div className="grid max-w-3xl gap-4">
            <Field
              label="Department"
              error={showErrors ? (check.name ?? undefined) : undefined}
              hint={match}
            >
              <Input
                id="checklist-name"
                value={draft.name}
                maxLength={31}
                autoComplete="off"
                aria-invalid={showErrors && check.name !== null}
                onChange={(event) => {
                  setDirty(true);
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
            </Field>
            <IndustryChoice
              industries={industries.data ?? []}
              chosen={industryIds}
              onChange={(next) => {
                setDirty(true);
                setIndustryIds(next);
              }}
            />
          </div>

          {S_SECTION_ORDER.map((section, sectionIndex) => {
            const first = sectionIndex * QUESTIONS_PER_SECTION;
            const written = draft.questions
              .slice(first, first + QUESTIONS_PER_SECTION)
              .filter((question) => question.text.trim() !== '').length;
            return (
              <fieldset key={section} className="min-w-0">
                <legend className="flex w-full items-baseline justify-between gap-3 border-b-2 border-ink pb-1">
                  <span className="gb-h2">{SECTION_LABEL[section]}</span>
                  <span className="font-mono text-xs text-ink-3 tabular-nums">
                    {written}/{QUESTIONS_PER_SECTION} written
                  </span>
                </legend>
                <div
                  aria-hidden
                  className="hidden gap-3 pt-2 md:grid md:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <span />
                  <span className="gb-label">English</span>
                  <span className="gb-label">Hindi · optional</span>
                  <span className="gb-label">Marathi · optional</span>
                </div>
                <ol>
                  {draft.questions.slice(first, first + QUESTIONS_PER_SECTION).map((question, offset) => {
                    const index = first + offset;
                    const sr = index + 1;
                    const error = showErrors ? check.errors[index] : null;
                    const warning =
                      [check.warnings[index], staleTranslation(index)].filter(Boolean).join(' · ') ||
                      null;
                    return (
                      <li
                        key={sr}
                        className="grid gap-2 border-b border-edge-soft py-2 md:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-3"
                      >
                        <span className="pt-2 font-mono text-xs text-ink-3 tabular-nums">{sr}</span>
                        <QuestionField
                          id={`question-${sr}-en`}
                          label="English"
                          sr={sr}
                          value={question.text}
                          maxLength={MAX_QUESTION_TEXT_LENGTH}
                          message={error ?? warning}
                          isError={Boolean(error)}
                          onChange={(value) => edit(index, 'text', value)}
                        />
                        <QuestionField
                          id={`question-${sr}-hi`}
                          label="Hindi"
                          lang="hi"
                          sr={sr}
                          value={question.hi}
                          maxLength={MAX_TRANSLATION_TEXT_LENGTH}
                          onChange={(value) => edit(index, 'hi', value)}
                        />
                        <QuestionField
                          id={`question-${sr}-mr`}
                          label="Marathi"
                          lang="mr"
                          sr={sr}
                          value={question.mr}
                          maxLength={MAX_TRANSLATION_TEXT_LENGTH}
                          onChange={(value) => edit(index, 'mr', value)}
                        />
                      </li>
                    );
                  })}
                </ol>
              </fieldset>
            );
          })}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={review}>Review changes</Button>
            <span className="text-xs text-ink-3" role="status">
              {showErrors && (invalid || noIndustryTicked)
                ? `Fix the ${[
                    check.name !== null && 'department name',
                    noIndustryTicked && 'industries',
                    check.errors.some(Boolean) &&
                      `${check.errors.filter(Boolean).length} unwritten question${check.errors.filter(Boolean).length === 1 ? '' : 's'}`,
                  ]
                    .filter(Boolean)
                    .join(', ')} first.`
                : 'Nothing has been saved yet. A blank Hindi or Marathi box keeps the translation already saved.'}
            </span>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={discarding}
        title="Discard this checklist?"
        confirmLabel="Discard"
        onConfirm={onClose}
        onCancel={() => setDiscarding(false)}
      >
        Nothing you wrote here has been saved.
      </ConfirmDialog>
    </Card>
  );
}

function QuestionField({
  id,
  label,
  sr,
  lang,
  value,
  maxLength,
  message,
  isError = false,
  onChange,
}: {
  id: string;
  label: string;
  sr: number;
  lang?: string;
  value: string;
  maxLength: number;
  message?: string | null;
  isError?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="gb-field min-w-0" htmlFor={id}>
      <span className="gb-label md:sr-only">
        {label}
        <span className="sr-only">, question {sr}</span>
      </span>
      <textarea
        id={id}
        lang={lang}
        rows={1}
        value={value}
        maxLength={maxLength}
        aria-invalid={isError || undefined}
        aria-describedby={message ? `${id}-message` : undefined}
        className="gb-input min-h-9 resize-y [field-sizing:content]"
        onChange={(event) => onChange(event.target.value)}
      />
      {message && (
        <span id={`${id}-message`} className={isError ? 'gb-field-error' : 'gb-hint'}>
          {message}
        </span>
      )}
    </label>
  );
}

/** The published version's questions, or the newest draft's for a checklist never published. */
async function questionsOf(template: ChecklistTemplate): Promise<ChecklistDraft['questions']> {
  const versionId =
    template.publishedVersionId ??
    (await api.get<Page<ChecklistVersion>>(`/checklist-versions?templateId=${template.id}&limit=1`))
      .data[0]?.id;
  if (!versionId) return blankQuestions();
  const detail = await api.get<ChecklistVersionDetail>(`/checklist-versions/${versionId}`);
  return [...detail.questions]
    .sort((a, b) => a.globalOrder - b.globalOrder)
    .map((question) => ({
      text: question.text,
      hi: question.translations?.hi ?? '',
      mr: question.translations?.mr ?? '',
    }));
}

/**
 * What committing will most likely do, in the import's terms (R-44): the same sheet name and
 * exactly the same industries make the next version; anything else a new checklist. The
 * review step shows the server's verdict, which is the one that counts.
 */
function matchFor(name: string, industryIds: string[], templates: ChecklistTemplate[]): string {
  const code = templateCodeForSheet(name.trim());
  if (code === '') return 'The department name, as on the workbook sheet. Up to 31 characters.';
  const key = [...industryIds].sort().join(',');
  const same = templates.filter((template) => templateCodeForSheet(template.name) === code);
  const version = same.find(
    (template) =>
      template.industries
        .map((industry) => industry.id)
        .sort()
        .join(',') === key,
  );
  if (version) {
    return `Committing makes the next version of ${version.name}${version.publishedVersionNumber ? ` (now v${version.publishedVersionNumber})` : ''}. Audits already started keep their version.`;
  }
  return same.length > 0
    ? `${same[0]!.name} exists for other industries; this makes a separate checklist.`
    : 'Committing makes a new checklist.';
}
