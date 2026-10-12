import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  OVERALL_ACTION_SUGGESTION_LIMIT,
  OVERALL_ACTION_SUGGESTION_MAX_LENGTH,
  type AuditDetail,
  type ChecklistVersionDetail,
  type Evidence,
  type EvidenceClassification,
  type ResponseValue,
  type SSection,
} from '@audit5s/contracts';
import { RESPONSE_TOKENS, S_SECTION_ORDER, formatScore, scoreZone, uuidv7, zoneDisplayLabel } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import { BandLabel } from '@/components/Status';
import { Button, Card, CardHeader, Dialog, DialogActions, ErrorNotice, Field, Input, Segmented, Select, Slip, Spinner } from '@/components/ui';
import { api, type DeviceApi } from '@/lib/api';
import { useWebDevice } from '@/lib/device';
import { uploadEvidence } from '@/lib/evidence';
import { PhotoPicker } from '@/lib/photo';
import { EvidenceThumb, ZONE_PHOTO_LIMIT, isZoneAuditPhoto, useAuditDetail, useZoneEvidence } from './shared';

type Zone = AuditDetail['zones'][number];
type Question = ChecklistVersionDetail['questions'][number];
type Language = 'en' | 'hi' | 'mr';

const SECTION_TITLE: Record<SSection, string> = {
  S1_SORT: '1S – SEIRI (SORT)',
  S2_SET_IN_ORDER: '2S – SEITON (SET IN ORDER)',
  S3_SHINE: '3S – SEISO (SHINE)',
  S4_STANDARDIZE: '4S – SEIKETSU (STANDARDIZE)',
  S5_SUSTAIN: '5S – SHITSUKE (SUSTAIN)',
};
const RESPONSES: ResponseValue[] = ['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'];
const LANG_KEY = 'audit5s.question-language';

/**
 * One Zone of an audit on the web (R-51): the phone's questionnaire
 * (`audit/[auditZoneId].tsx`) or, on a walk-by, its photographs (`walk-by/[auditZoneId].tsx`).
 * Every answer is saved to the server as it is given, as this browser's device; the score
 * shown is the server's, recomputed on every save (D5). Photographs come from the camera
 * or a file (owner, 2026-10-12, R-51); `isLiveCapture` records which. Only the selfie is live.
 */
export function ZoneRunPage({ auditId, auditZoneId }: { auditId: string; auditZoneId: string }) {
  const device = useWebDevice();
  const detail = useAuditDetail(auditId);
  const evidence = useZoneEvidence(auditZoneId);
  const audit = detail.data;
  const zone = audit?.zones.find((z) => z.id === auditZoneId);
  useDocumentTitle(zone ? zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot) : 'Zone');

  if (detail.isLoading || evidence.isLoading) return <Spinner />;
  if (detail.error) return <ErrorNotice error={detail.error} missing="This audit doesn't exist, or isn't yours." />;
  if (!audit || !zone) return <ErrorNotice error={new Error('This Zone is not in this audit.')} />;

  const mine = audit.owningDeviceId === null || audit.owningDeviceId === device.deviceId;
  const editable = audit.status === 'IN_PROGRESS' && mine && zone.status !== 'WITHDRAWN' && device.client !== null;
  const props = { audit, zone, evidence: evidence.data ?? [], editable, client: device.client };
  return audit.auditType === 'WALK_BY' ? <WalkBy {...props} /> : <Questionnaire {...props} />;
}

interface ZoneProps {
  audit: AuditDetail;
  zone: Zone;
  evidence: Evidence[];
  editable: boolean;
  client: DeviceApi | null;
}

function NotEditable({ audit }: { audit: AuditDetail }) {
  if (audit.status === 'IN_PROGRESS') return <Slip title="Open on another device">Save &amp; pause it there, then resume it from the audit here.</Slip>;
  if (audit.status === 'PAUSED') return <Slip title="Paused">Resume the audit from its Zones to carry on.</Slip>;
  return null;
}

function useRefresh(auditZoneId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['conduct', 'audit'] }),
      queryClient.invalidateQueries({ queryKey: ['conduct', 'evidence', auditZoneId] }),
    ]);
}

// --------------------------------------------------------------------- the questions

function Questionnaire({ audit, zone, evidence, editable, client }: ZoneProps) {
  const navigate = useNavigate();
  const refresh = useRefresh(zone.id);
  const version = useQuery({
    queryKey: ['checklist-version', zone.checklistVersionId],
    queryFn: () => api.get<ChecklistVersionDetail>(`/checklist-versions/${zone.checklistVersionId}`),
    enabled: Boolean(zone.checklistVersionId),
    staleTime: Infinity,
  });
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return (localStorage.getItem(LANG_KEY) as Language | null) ?? 'en';
    } catch {
      return 'en';
    }
  });
  const chooseLanguage = (next: Language) => {
    setLanguage(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      // A private window: the choice lasts for this page only.
    }
  };

  // What was answered, keyed by question; ids are kept so a response is always the same row.
  const [answers, setAnswers] = useState<Record<string, { id: string; value: ResponseValue | null; remark: string | null }>>(() =>
    Object.fromEntries(zone.responses.map((r) => [r.checklistQuestionId, { id: r.id, value: r.value, remark: r.remark }])),
  );
  const [section, setSection] = useState<SSection>(S_SECTION_ORDER[0]!);
  const [showMissing, setShowMissing] = useState(false);
  const [remark, setRemark] = useState(zone.zoneRemark ?? '');
  const [suggestions, setSuggestions] = useState<string[]>(zone.overallActionSuggestions ?? []);
  const [cameraFor, setCameraFor] = useState<Question | null>(null);
  const [viewing, setViewing] = useState<Evidence | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useMutation({
    mutationFn: async ({ question, value, remark: note }: { question: Question; value: ResponseValue; remark: string | null }) => {
      const id = answers[question.id]?.id ?? uuidv7();
      setAnswers((current) => ({ ...current, [question.id]: { id, value, remark: note } }));
      const now = new Date().toISOString();
      await client!.put(
        `/audit-zones/${zone.id}/responses/${id}`,
        { checklistQuestionId: question.id, value, remark: note, answeredAt: now, clientUpdatedAt: now },
        uuidv7(),
      );
    },
    // The score is the server's: re-read a moment after the last tap, not after every one.
    onSuccess: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), 800);
    },
  });
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  const capture = useMutation({
    mutationFn: async ({ question, blob, live }: { question: Question; blob: Blob; live: boolean }) => {
      const answer = answers[question.id];
      await uploadEvidence(
        blob,
        {
          kind: 'QUESTION_EVIDENCE',
          auditId: audit.id,
          auditZoneId: zone.id,
          questionResponseId: answer!.id,
          isLiveCapture: live,
        },
        client!,
      );
    },
    onSuccess: async () => {
      setCameraFor(null);
      await refresh();
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      const kept = suggestions.map((s) => s.trim()).filter(Boolean);
      await client!.put(
        `/audits/${audit.id}/zones/${zone.id}`,
        { zoneId: zone.zoneId, sequenceNo: zone.sequenceNo, zoneRemark: remark.trim() || null, overallActionSuggestions: kept, clientUpdatedAt: new Date().toISOString() },
        uuidv7(),
      );
      await client!.post(`/audits/${audit.id}/zones/${zone.id}/complete`, { zoneRemark: remark.trim() || null, completedAt: new Date().toISOString() }, uuidv7());
    },
    onSuccess: async () => {
      await refresh();
      void navigate({ to: '/conduct/$auditId', params: { auditId: audit.id } });
    },
  });

  const questions = version.data?.questions ?? [];
  const bySection = useMemo(() => {
    const map = new Map<SSection, Question[]>();
    for (const q of [...questions].sort((a, b) => a.globalOrder - b.globalOrder)) map.set(q.section, [...(map.get(q.section) ?? []), q]);
    return map;
  }, [questions]);

  if (version.isLoading) return <Spinner />;
  if (version.error) return <ErrorNotice error={version.error} />;

  const photos = evidence.filter((e) => isZoneAuditPhoto(e.kind));
  const full = photos.length >= ZONE_PHOTO_LIMIT;
  const unanswered = questions.filter((q) => !answers[q.id]?.value);
  const sectionIndex = S_SECTION_ORDER.indexOf(section);
  const reviewing = editable && zone.status === 'COMPLETED';
  // The phone's live figure: `scoreZone` from the domain package, the function the server runs.
  const local = scoreZone(
    questions.flatMap((q) => {
      const value = answers[q.id]?.value;
      return value ? [{ section: q.section, value }] : [];
    }),
  ).totals.scorePercentage;
  const score = zone.status === 'COMPLETED' && !reviewing ? zone.totals.scorePercentage : local;

  return (
    <div className="space-y-4 pb-24">
      {!editable ? <NotEditable audit={audit} /> : null}
      {reviewing ? <Slip title="Reviewing a finished Zone">Changes count once you save them: the Zone is rescored.</Slip> : null}

      <Card>
        <CardHeader
          title={zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
          description={[zone.checklistTemplateNameSnapshot, zone.zoneLeaderNameSnapshot && `Leader ${zone.zoneLeaderNameSnapshot}`].filter(Boolean).join(' · ')}
          action={
            <Segmented
              label="Question language"
              options={[
                { value: 'en', label: 'English' },
                { value: 'hi', label: 'हिंदी' },
                { value: 'mr', label: 'मराठी' },
              ]}
              value={language}
              onChange={chooseLanguage}
            />
          }
        />
        <div className="space-y-2 p-4 text-sm">
          <p className="gb-label">Marking scheme</p>
          <p className="text-ink-2">
            {RESPONSES.map((value) => `${RESPONSE_TOKENS[value]!.marks ?? 'NA'} · ${RESPONSE_TOKENS[value]!.label}`).join('   ')}
          </p>
          <p className="text-ink-2">Every question is compulsory. Use NA only when the checkpoint does not apply here.</p>
          <p className="gb-data text-ink-2">
            {photos.length} of {ZONE_PHOTO_LIMIT} photos in this Zone
          </p>
        </div>
      </Card>

      <div className="gb-seg flex-wrap" role="tablist" aria-label="Sections">
        {S_SECTION_ORDER.map((s) => {
          const list = bySection.get(s) ?? [];
          const done = list.filter((q) => answers[q.id]?.value).length;
          return (
            <button key={s} type="button" role="tab" aria-pressed={s === section} aria-selected={s === section} onClick={() => setSection(s)}>
              {s.slice(0, 2)} · {done}/{list.length}
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader title={SECTION_TITLE[section]} />
        <ol className="divide-y divide-edge-soft">
          {(bySection.get(section) ?? []).map((question) => {
            const answer = answers[question.id];
            const own = answer ? evidence.filter((e) => e.questionResponseId === answer.id) : [];
            const translated = language === 'en' ? null : question.translations?.[language]?.trim();
            const missing = showMissing && !answer?.value;
            return (
              <li key={question.id} className={missing ? 'gb-conduct-q gb-conduct-q--missing' : 'gb-conduct-q'}>
                <p className="text-ink">
                  <b className="gb-data mr-2">Q{question.globalOrder}</b>
                  {translated || question.text}
                </p>
                {translated ? <p className="text-sm text-ink-2">{question.text}</p> : null}
                {question.guidance ? <p className="text-sm text-ink-2">{question.guidance}</p> : null}
                <div className="flex flex-wrap gap-2" role="group" aria-label={`Answer Q${question.globalOrder}`}>
                  {RESPONSES.filter((value) => value !== 'NA' || question.allowsNa).map((value) => (
                    <Button
                      key={value}
                      variant="secondary"
                      aria-pressed={answer?.value === value}
                      disabled={!editable}
                      onClick={() => save.mutate({ question, value, remark: answer?.remark ?? null })}
                    >
                      <b className="mr-1">{RESPONSE_TOKENS[value]!.marks ?? 'NA'}</b> {RESPONSE_TOKENS[value]!.label}
                    </Button>
                  ))}
                </div>
                {missing ? <span className="gb-field-error">Answer required</span> : null}
                <div className="flex flex-wrap items-center gap-2">
                  {own.map((e) => (
                    <EvidenceThumb key={e.id} evidence={e} onOpen={() => setViewing(e)} />
                  ))}
                  {editable ? (
                    <Button variant="secondary" disabled={!answer?.value || full} title={!answer?.value ? 'Answer first' : full ? 'This Zone has 25 photos' : undefined} onClick={() => setCameraFor(question)}>
                      Add photo
                    </Button>
                  ) : null}
                </div>
                <Input
                  aria-label={`Remark for Q${question.globalOrder}`}
                  placeholder="Remark (optional)"
                  disabled={!editable || !answer?.value}
                  defaultValue={answer?.remark ?? ''}
                  onBlur={(event) => {
                    const note = event.target.value.trim() || null;
                    if (answer?.value && note !== (answer.remark ?? null)) save.mutate({ question, value: answer.value, remark: note });
                  }}
                />
              </li>
            );
          })}
        </ol>
        <div className="flex justify-between gap-2 p-4">
          <Button variant="secondary" disabled={sectionIndex === 0} onClick={() => setSection(S_SECTION_ORDER[sectionIndex - 1]!)}>
            Previous
          </Button>
          {sectionIndex < S_SECTION_ORDER.length - 1 ? (
            <Button onClick={() => setSection(S_SECTION_ORDER[sectionIndex + 1]!)}>Next</Button>
          ) : null}
        </div>
      </Card>
      <ErrorNotice error={save.error} />

      <Card>
        <CardHeader
          title="Zone score"
          description={zone.status === 'COMPLETED' ? "The server's figure." : 'Worked out from your answers the way the server does. The server settles it when the Zone is submitted.'}
        />
        <div className="flex flex-wrap items-center gap-4 p-4">
          <b className="gb-figure" style={{ fontSize: 33 }}>
            {score === null ? 'N/A' : `${formatScore(score)}%`}
          </b>
          <BandLabel score={score} />
          <span className="gb-data text-ink-2">
            {questions.length - unanswered.length} of {questions.length} answered
          </span>
        </div>
      </Card>

      {editable ? (
        <Card>
          <CardHeader title="Overall" />
          <div className="space-y-4 p-4">
            <Field label="Overall remark">
              <textarea className="gb-input" rows={3} maxLength={4000} value={remark} onChange={(event) => setRemark(event.target.value)} />
            </Field>
            <div className="space-y-2">
              <p className="gb-label">Overall corrective actions (optional)</p>
              {suggestions.map((text, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    aria-label={`Suggestion ${index + 1}`}
                    value={text}
                    maxLength={OVERALL_ACTION_SUGGESTION_MAX_LENGTH}
                    onChange={(event) => setSuggestions((all) => all.map((s, at) => (at === index ? event.target.value : s)))}
                  />
                  <Button variant="secondary" onClick={() => setSuggestions((all) => all.filter((_, at) => at !== index))}>
                    Remove
                  </Button>
                </div>
              ))}
              {suggestions.length < OVERALL_ACTION_SUGGESTION_LIMIT ? (
                <Button variant="secondary" onClick={() => setSuggestions((all) => [...all, ''])}>
                  + Add a suggestion
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {editable ? (
        <div className="gb-kz-formbar">
          <span className="text-sm">
            <b>{unanswered.length === 0 ? 'All questions answered' : `${unanswered.length} unanswered`}</b>
          </span>
          <Button
            disabled={finish.isPending || photos.length > ZONE_PHOTO_LIMIT}
            onClick={() => {
              if (unanswered.length > 0) {
                setShowMissing(true);
                setSection(unanswered[0]!.section);
                return;
              }
              finish.mutate();
            }}
          >
            {finish.isPending ? 'Saving…' : reviewing ? 'Save changes' : 'Submit Zone'}
          </Button>
        </div>
      ) : null}
      {showMissing && unanswered.length > 0 ? (
        <p className="gb-notice" role="alert">
          Unanswered: {unanswered.map((q) => `Q${q.globalOrder}`).join(', ')}.
        </p>
      ) : null}
      <ErrorNotice error={finish.error} />

      <Dialog open={cameraFor !== null} onClose={() => setCameraFor(null)} title={cameraFor ? `Photograph for Q${cameraFor.globalOrder}` : 'Photograph'}>
        <div className="gb-dialog-section space-y-2">
          {cameraFor ? (
            <PhotoPicker
              photoUrl={null}
              onRemove={() => undefined}
              onPhoto={(blob, live) => capture.mutate({ question: cameraFor, blob, live })}
              hint="Take a photograph now, or choose a file from this computer."
            />
          ) : null}
          {capture.isPending ? <p className="text-sm text-ink-2">Uploading…</p> : null}
          <ErrorNotice error={capture.error} />
        </div>
      </Dialog>
      {viewing ? <PhotoDialog evidence={viewing} editable={editable} client={client} onClose={() => setViewing(null)} onChanged={refresh} /> : null}
    </div>
  );
}

// ----------------------------------------------------------------------- the walk-by

const CLASSIFICATIONS: { value: EvidenceClassification; label: string }[] = [
  { value: 'GOOD', label: 'Good' },
  { value: 'NONCONFORMITY', label: 'Nonconformity' },
  { value: 'NEUTRAL', label: 'Neutral' },
];

function WalkBy({ audit, zone, evidence, editable, client }: ZoneProps) {
  const navigate = useNavigate();
  const refresh = useRefresh(zone.id);
  const [classification, setClassification] = useState<EvidenceClassification>('NEUTRAL');
  const [camera, setCamera] = useState(false);
  const [remark, setRemark] = useState(zone.zoneRemark ?? '');
  const [viewing, setViewing] = useState<Evidence | null>(null);
  const photos = evidence.filter((e) => e.kind === 'WALK_BY_PHOTO');
  const full = photos.length >= ZONE_PHOTO_LIMIT;

  const capture = useMutation({
    mutationFn: ({ blob, live }: { blob: Blob; live: boolean }) =>
      uploadEvidence(blob, { kind: 'WALK_BY_PHOTO', auditId: audit.id, auditZoneId: zone.id, classification, isLiveCapture: live }, client!),
    onSuccess: async () => {
      setCamera(false);
      await refresh();
    },
  });
  const finish = useMutation({
    mutationFn: async () => {
      if (photos.length === 0) throw new Error('Take at least one photograph before finishing this Zone.');
      await client!.post(`/audits/${audit.id}/zones/${zone.id}/complete`, { zoneRemark: remark.trim() || null, completedAt: new Date().toISOString() }, uuidv7());
    },
    onSuccess: async () => {
      await refresh();
      void navigate({ to: '/conduct/$auditId', params: { auditId: audit.id } });
    },
  });

  return (
    <div className="space-y-4 pb-24">
      {!editable ? <NotEditable audit={audit} /> : null}
      <Card>
        <CardHeader
          title={zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}
          description={`Walk-by · ${photos.length} of ${ZONE_PHOTO_LIMIT} photos${zone.zoneLeaderNameSnapshot ? ` · Leader ${zone.zoneLeaderNameSnapshot}` : ''}`}
        />
        <div className="space-y-4 p-4">
          {editable ? (
            camera ? (
              <div className="max-w-md space-y-2">
                <Field label="This photograph shows">
                  <Select value={classification} onChange={(event) => setClassification(event.target.value as EvidenceClassification)}>
                    {CLASSIFICATIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <PhotoPicker
                  photoUrl={null}
                  onRemove={() => undefined}
                  onPhoto={(blob, live) => capture.mutate({ blob, live })}
                  hint="Take a photograph now, or choose a file from this computer."
                />
                {capture.isPending ? <p className="text-sm text-ink-2">Uploading…</p> : null}
                <ErrorNotice error={capture.error} />
              </div>
            ) : (
              <Button disabled={full} onClick={() => setCamera(true)}>
                Add photo
              </Button>
            )
          ) : null}
          <div className="flex flex-wrap gap-2">
            {photos.map((e) => (
              <EvidenceThumb key={e.id} evidence={e} onOpen={() => setViewing(e)} />
            ))}
          </div>
          {editable ? (
            <Field label="Overall remark">
              <textarea className="gb-input" rows={3} maxLength={4000} value={remark} onChange={(event) => setRemark(event.target.value)} />
            </Field>
          ) : null}
        </div>
      </Card>
      {editable ? (
        <div className="gb-kz-formbar">
          <span className="text-sm">
            <b>{photos.length === 0 ? 'Take at least one photograph' : `${photos.length} photograph${photos.length === 1 ? '' : 's'}`}</b>
          </span>
          <Button disabled={finish.isPending} onClick={() => finish.mutate()}>
            {finish.isPending ? 'Saving…' : 'Finish Zone'}
          </Button>
        </div>
      ) : null}
      <ErrorNotice error={finish.error} />
      {viewing ? <PhotoDialog evidence={viewing} editable={editable} walkBy client={client} onClose={() => setViewing(null)} onChanged={refresh} /> : null}
    </div>
  );
}

// ----------------------------------------------------------------------- one photograph

/** Preview, flag for the summary, delete; on a walk-by also its classification and remark. */
function PhotoDialog({
  evidence,
  editable,
  walkBy = false,
  client,
  onClose,
  onChanged,
}: {
  evidence: Evidence;
  editable: boolean;
  walkBy?: boolean;
  client: DeviceApi | null;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [remark, setRemark] = useState(evidence.remark ?? '');
  const [classification, setClassification] = useState(evidence.classification);
  const view = useQuery({
    queryKey: ['evidence-view-url', evidence.id, 'original'],
    queryFn: () => api.get<{ url: string }>(`/evidence/${evidence.id}/view-url?variant=original`),
    staleTime: 240_000,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => client!.patch(`/evidence/${evidence.id}`, body),
    onSuccess: async () => {
      await onChanged();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => client!.delete(`/evidence/${evidence.id}`),
    onSuccess: async () => {
      await onChanged();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Photograph" wide>
      <div className="gb-dialog-section space-y-3">
        {view.data ? <img src={view.data.url} alt="" className="w-full border border-edge-soft" referrerPolicy="no-referrer" /> : <Spinner />}
        {editable && walkBy ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="This photograph shows">
              <Select value={classification} onChange={(event) => setClassification(event.target.value as EvidenceClassification)}>
                {CLASSIFICATIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Remark">
              <Input value={remark} maxLength={2000} onChange={(event) => setRemark(event.target.value)} />
            </Field>
          </div>
        ) : null}
        <ErrorNotice error={patch.error ?? remove.error} />
      </div>
      <DialogActions>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {editable ? (
          <>
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete photo
            </Button>
            <Button variant="secondary" disabled={patch.isPending} onClick={() => patch.mutate({ isSummaryFlagged: !evidence.isSummaryFlagged })}>
              {evidence.isSummaryFlagged ? 'Remove from summary' : 'Flag for summary'}
            </Button>
            {walkBy ? (
              <Button disabled={patch.isPending} onClick={() => patch.mutate({ classification, remark: remark.trim() || null })}>
                Save
              </Button>
            ) : null}
          </>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
