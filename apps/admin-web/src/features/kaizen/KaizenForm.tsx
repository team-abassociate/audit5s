import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  KAIZEN_PARAMETERS,
  KAIZEN_WASTES,
  type KaizenDetail,
  type KaizenFields,
  type KaizenPhoto,
  type KaizenPhotoKind,
  type KaizenPhotoUploadIntentResponse,
  type Page,
  type Zone,
} from '@audit5s/contracts';
import { missingKaizenFields, uuidv7, zoneDisplayLabel } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import { Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNotice, Field, Input, Select, Slip, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { KAIZEN_PARAMETER_LABEL, KAIZEN_WASTE_LABEL } from '@/lib/labels';
import { PhotoPicker, putObject, sha256Hex } from '@/lib/photo';
import { useSession } from '@/lib/session';

/**
 * New Kaizen and Edit & resubmit on the web: the phone's twelve steps
 * (`kaizen-form.tsx`), laid out as one page of sections because a desk has the room.
 *
 * The web is online, so there is no outbox: every change is saved to the server a moment
 * after the last keystroke by `POST /kaizens`, which is an upsert on the id this page mints
 * (UUIDv7, as the phone's). Photos go up the same two-phase way the phone's do — intent,
 * a PUT straight to storage, commit — and either may come from the computer's files or
 * its camera (R-48: the gallery is allowed for both Kaizen photos). Submit saves, then
 * `POST /kaizens/{id}/submit` with a fresh submission id.
 */

type Sheet = Required<{ [K in keyof KaizenFields]: Exclude<KaizenFields[K], undefined> }>;

const EMPTY: Sheet = {
  machine: null,
  lineArea: null,
  implementedOn: null,
  teamMembers: null,
  theme: null,
  target: null,
  problem5w1h: null,
  rootCause4m: null,
  analysis7qc: null,
  countermeasure: null,
  wastes: [],
  parameters: [],
  horizontalDeployment: null,
  benefits: null,
  annualSaving: null,
  implementationCost: null,
  ideaBy: null,
  implementedBy: null,
};

function sheetOf(kaizen: KaizenDetail): Sheet {
  const sheet = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof Sheet)[]) (sheet as Record<string, unknown>)[key] = kaizen[key];
  return sheet;
}

type TextKey = Exclude<keyof Sheet, 'wastes' | 'parameters' | 'horizontalDeployment' | 'annualSaving' | 'implementationCost'>;

/** The phone's words (`kaizen-strings.ts`, English), so a step reads the same on both. */
const LABEL: Record<TextKey | 'annualSaving' | 'implementationCost', string> = {
  machine: 'Machine',
  lineArea: 'Line / area',
  implementedOn: 'Date of implementation',
  teamMembers: 'Team members',
  theme: 'Theme',
  target: 'Target & target date (optional)',
  problem5w1h: 'Problem [5W1H]',
  countermeasure: 'Countermeasure',
  benefits: 'Benefits, results and saving calculation',
  annualSaving: 'Annual cost saving, ₹ (optional)',
  implementationCost: 'Cost to implement, ₹ (optional)',
  rootCause4m: 'Root cause [4M]',
  analysis7qc: 'Analysis [7 QC tools] (optional)',
  ideaBy: 'Idea given by',
  implementedBy: 'Implemented by',
};
const HINT: Partial<Record<keyof Sheet, string>> = {
  teamMembers: 'Names, separated by commas',
  theme: 'One line: what you improved. e.g. Quick-release clamps on the P-04 die',
  problem5w1h: 'What, where, when, who, which and how. e.g. Die change on P-04 takes 40 min because…',
  rootCause4m: 'Man, machine, method or material: which one caused it, and why?',
  analysis7qc: 'Optional. e.g. Pareto chart, fishbone, check sheet',
  benefits: 'What changed, in numbers if you have them. e.g. Changeover 40 → 12 min',
  implementationCost: 'What it cost to put in. Enter 0 if it cost nothing.',
};
const LONG = new Set<keyof Sheet>(['teamMembers', 'problem5w1h', 'countermeasure', 'benefits', 'rootCause4m', 'analysis7qc']);
const MAX: Partial<Record<keyof Sheet, number>> = { theme: 300, target: 300 };
const REQUIRED = new Set<string>(missingKaizenFields({}));

const SAVE_DELAY_MS = 800;

export function KaizenFormPage({ kaizenId }: { kaizenId?: string }) {
  const { can } = useSession();
  useDocumentTitle(kaizenId ? 'Edit Kaizen' : 'New Kaizen');
  const existing = useQuery({
    queryKey: ['kaizen', kaizenId],
    queryFn: () => api.get<KaizenDetail>(`/kaizens/${kaizenId}`),
    enabled: kaizenId !== undefined,
  });

  if (!can('kaizen', 'create')) return <EmptyState title="Only a Zone Leader records Kaizens." />;
  if (!kaizenId) return <Form key="new" />;
  if (existing.isLoading) return <Spinner />;
  if (existing.error) return <ErrorNotice error={existing.error} missing="This Kaizen doesn't exist, or isn't yours." />;
  const kaizen = existing.data!;
  if (kaizen.status !== 'DRAFT' && kaizen.status !== 'SENT_BACK') {
    return (
      <EmptyState
        title="This Kaizen can no longer be edited."
        action={
          <Link to="/kaizen/list" search={{ kaizen: kaizen.id } as never} className="gb-btn">
            Open it
          </Link>
        }
      >
        Only a draft, or a Kaizen sent back to you, can be changed.
      </EmptyState>
    );
  }
  return <Form key={kaizen.id} initial={kaizen} />;
}

/** The leader's own Zones in their Unit (R-39): the Kaizen is filed under one, and keeps it. */
function useLeaderZones() {
  const { user, scope } = useSession();
  const unitIds = scope?.unitIds ?? [];
  return useQuery({
    queryKey: ['leader-zones', user?.id, unitIds.join(',')],
    queryFn: async () => {
      const pages = await Promise.all(unitIds.map((unitId) => api.get<Page<Zone>>(`/units/${unitId}/zones?active=true&limit=200`)));
      return pages.flatMap((page) => page.data).filter((zone) => zone.zoneLeaderId === user?.id);
    },
    enabled: Boolean(user),
  });
}

function Form({ initial }: { initial?: KaizenDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const zones = useLeaderZones();
  const [id] = useState(() => initial?.id ?? uuidv7());
  const [zoneId, setZoneId] = useState<string | null>(initial?.zoneId ?? null);
  const [sheet, setSheet] = useState<Sheet>(() => (initial ? sheetOf(initial) : EMPTY));
  // Whether the server holds a row for `id` yet: a page opened and left untouched files nothing.
  const [onServer, setOnServer] = useState(Boolean(initial));
  const [photos, setPhotos] = useState<{ BEFORE: KaizenPhoto | null; AFTER: KaizenPhoto | null }>({
    BEFORE: initial?.beforePhoto ?? null,
    AFTER: initial?.afterPhoto ?? null,
  });
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(initial ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = initial?.status ?? 'DRAFT';

  useEffect(() => {
    if (zoneId === null && zones.data?.[0]) setZoneId(zones.data[0].id);
  }, [zoneId, zones.data]);

  // The latest sheet, for a save that was queued before the last keystroke.
  const latest = useRef({ sheet, zoneId });
  latest.current = { sheet, zoneId };
  const inFlight = useRef<Promise<void> | null>(null);

  const save = useCallback(async (): Promise<void> => {
    // One save at a time, then one more with whatever changed meanwhile.
    while (inFlight.current) await inFlight.current;
    const { sheet: body, zoneId: zone } = latest.current;
    if (!zone) throw new Error('Choose the Zone this Kaizen is for.');
    setSaveState('saving');
    const run = api
      .post<KaizenDetail>('/kaizens', { id, zoneId: zone, ...body }, uuidv7())
      .then((saved) => {
        setOnServer(true);
        setSaveError(null);
        setSaveState(latest.current.sheet === body ? 'saved' : 'dirty');
        queryClient.setQueryData(['kaizen', id], saved);
      })
      .catch((error: unknown) => {
        setSaveError(error);
        setSaveState('error');
        throw error;
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run.catch(() => undefined);
    return run;
  }, [id, queryClient]);

  // Debounced autosave after any change to the sheet.
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const timer = setTimeout(() => void save().catch(() => undefined), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sheet, saveState, save]);

  const set = <K extends keyof Sheet>(key: K, value: Sheet[K]) => {
    setSheet((previous) => ({ ...previous, [key]: value }));
    setSaveState('dirty');
  };

  const missing = new Set<string>(missingKaizenFields(sheet));
  const errorFor = (key: keyof Sheet) => (showMissing && missing.has(key) ? 'Fill this in.' : undefined);

  const submit = useMutation({
    mutationFn: async () => {
      await save();
      return api.post<KaizenDetail>(`/kaizens/${id}/submit`, { submissionId: uuidv7() });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kaizens'] });
      await queryClient.invalidateQueries({ queryKey: ['kaizen', id] });
      void navigate({ to: '/kaizen', search: { submitted: status === 'SENT_BACK' ? 'again' : 'new' } as never });
    },
  });

  const discard = useMutation({
    mutationFn: () => api.post(`/kaizens/${id}/discard`, undefined, uuidv7()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kaizens'] });
      void navigate({ to: '/kaizen' });
    },
  });

  if (zones.isLoading) return <Spinner />;
  if (zones.error) return <ErrorNotice error={zones.error} />;
  if (!initial && (zones.data?.length ?? 0) === 0) {
    return <EmptyState title="You don't lead a Zone yet.">A Kaizen is filed under your Zone. Ask your Coordinator to make you a Zone's leader.</EmptyState>;
  }

  const zone = zones.data?.find((z) => z.id === zoneId);
  const reason = status === 'SENT_BACK' ? initial?.latestReview : null;
  const stepsLeft = KAIZEN_STEP_ITEMS.filter((step) => step.items.some((item) => missing.has(item))).length;

  const text = (key: TextKey) => (
    <Field key={key} label={LABEL[key]} {...(HINT[key] ? { hint: HINT[key] } : {})} {...(errorFor(key) ? { error: errorFor(key)! } : {})}>
      {key === 'implementedOn' ? (
        <Input type="date" value={sheet.implementedOn ?? ''} onChange={(event) => set('implementedOn', event.target.value || null)} />
      ) : LONG.has(key) ? (
        <textarea className="gb-input" rows={3} maxLength={4000} value={sheet[key] ?? ''} onChange={(event) => set(key, event.target.value || null)} />
      ) : (
        <Input maxLength={MAX[key] ?? 200} value={sheet[key] ?? ''} onChange={(event) => set(key, event.target.value || null)} />
      )}
    </Field>
  );

  const rupees = (key: 'annualSaving' | 'implementationCost') => (
    <Field key={key} label={LABEL[key]} {...(HINT[key] ? { hint: HINT[key] } : {})}>
      <Input
        inputMode="decimal"
        value={sheet[key] === null ? '' : String(sheet[key])}
        onChange={(event) => {
          const raw = event.target.value.replace(/[,₹\s]/g, '');
          if (raw === '') set(key, null);
          else if (/^\d{0,12}(\.\d{0,2})?$/.test(raw)) set(key, Number(raw));
        }}
      />
    </Field>
  );

  return (
    <div className="space-y-4 pb-24">
      {reason ? (
        <Slip title={`Sent back by ${reason.reviewerName}`}>{reason.comment ?? 'Fix it and resubmit.'}</Slip>
      ) : null}

      <Card>
        <CardHeader
          title={initial ? `${initial.kaizenNo} · ${status === 'SENT_BACK' ? 'Edit & resubmit' : 'Draft'}` : 'New Kaizen'}
          description="Each field is saved as you go. Photos are optional."
        />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Zone">
            {initial ? (
              <Input value={zoneDisplayLabel(initial.zoneCode, initial.zoneName)} disabled />
            ) : (
              <Select value={zoneId ?? ''} disabled={onServer} onChange={(event) => setZoneId(event.target.value)}>
                {zones.data?.map((z) => (
                  <option key={z.id} value={z.id}>
                    {zoneDisplayLabel(z.code, z.name)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {zone || initial ? null : <p className="text-sm text-ink-2">Choose the Zone this Kaizen is for.</p>}
        </div>
      </Card>

      <Step n={1} title="Kaizen details" state={stepState(['machine', 'lineArea', 'implementedOn'], missing, sheet)}>
        <div className="grid gap-4 sm:grid-cols-3">{(['machine', 'lineArea', 'implementedOn'] as const).map(text)}</div>
      </Step>
      <Step n={2} title="Team members" state={stepState(['teamMembers'], missing, sheet)}>
        {text('teamMembers')}
      </Step>
      <Step n={3} title="Kaizen theme" state={stepState(['theme', 'target'], missing, sheet)}>
        {text('theme')}
        {text('target')}
      </Step>
      <Step n={4} title="Problem" state={stepState(['problem5w1h'], missing, sheet)}>
        {text('problem5w1h')}
      </Step>
      <Step n={5} title="Countermeasure" state={stepState(['countermeasure'], missing, sheet)}>
        {text('countermeasure')}
      </Step>
      <div className="grid gap-4 lg:grid-cols-2">
        {(['BEFORE', 'AFTER'] as const).map((kind, index) => (
          <Step
            key={kind}
            n={6 + index}
            title={kind === 'BEFORE' ? 'Before countermeasure' : 'After countermeasure'}
            state={photos[kind] ? 'done' : 'optional'}
          >
            <PhotoSlot
              kaizenId={id}
              kind={kind}
              photo={photos[kind]}
              ensureSaved={async () => {
                if (!onServer || saveState === 'dirty') await save();
              }}
              onChange={(photo) => setPhotos((previous) => ({ ...previous, [kind]: photo }))}
            />
          </Step>
        ))}
      </div>
      <Step n={8} title="Waste attacked" state={sheet.wastes.length ? 'done' : 'optional'}>
        <Toggles
          options={KAIZEN_WASTES.map((value) => ({ value, label: KAIZEN_WASTE_LABEL[value] }))}
          value={sheet.wastes}
          onChange={(value) => set('wastes', value)}
          label="Waste attacked"
        />
      </Step>
      <Step n={9} title="Parameters" state={sheet.parameters.length ? 'done' : 'optional'}>
        <Toggles
          options={KAIZEN_PARAMETERS.map((value) => ({ value, label: KAIZEN_PARAMETER_LABEL[value] }))}
          value={sheet.parameters}
          onChange={(value) => set('parameters', value)}
          label="Parameters"
        />
      </Step>
      <Step n={10} title="Use on other machines?" state={stepState(['horizontalDeployment'], missing, sheet)}>
        <p className="text-sm text-ink">Can this be deployed on other machines or lines?</p>
        <div className="flex gap-2" role="group" aria-label="Horizontal deployment">
          {[
            { value: true, label: 'Yes' },
            { value: false, label: 'No' },
          ].map((option) => (
            <Button
              key={option.label}
              variant="secondary"
              aria-pressed={sheet.horizontalDeployment === option.value}
              onClick={() => set('horizontalDeployment', option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {errorFor('horizontalDeployment') ? <span className="gb-field-error">Fill this in.</span> : null}
      </Step>
      <Step n={11} title="Benefits / saving" state={stepState(['benefits', 'annualSaving', 'implementationCost'], missing, sheet)}>
        {text('benefits')}
        <div className="grid gap-4 sm:grid-cols-2">
          {rupees('annualSaving')}
          {rupees('implementationCost')}
        </div>
      </Step>
      <Step n={12} title="Root cause & people" state={stepState(['rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy'], missing, sheet)}>
        {text('rootCause4m')}
        {text('analysis7qc')}
        <div className="grid gap-4 sm:grid-cols-2">
          {text('ideaBy')}
          {text('implementedBy')}
        </div>
      </Step>

      <div className="gb-kz-formbar">
        <div className="min-w-0 text-sm">
          <b>{stepsLeft === 0 ? 'Ready to submit' : `${stepsLeft} required ${stepsLeft === 1 ? 'step' : 'steps'} left`}</b>
          <span className="gb-data ml-3 text-ink-2" role="status">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'error' ? 'Not saved' : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {onServer && status === 'DRAFT' ? (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              Delete draft
            </Button>
          ) : null}
          <Button
            disabled={submit.isPending}
            onClick={() => {
              if (missing.size > 0) {
                setShowMissing(true);
                document.querySelector('.gb-field-error')?.scrollIntoView({ block: 'center' });
                return;
              }
              submit.mutate();
            }}
          >
            {submit.isPending ? 'Submitting…' : status === 'SENT_BACK' ? 'Resubmit Kaizen' : 'Submit Kaizen'}
          </Button>
        </div>
      </div>
      {showMissing && missing.size > 0 ? (
        <p className="gb-notice" role="alert">
          {missing.size} required {missing.size === 1 ? 'item is' : 'items are'} empty: {[...missing].map((key) => LABEL[key as TextKey] ?? 'Use on other machines?').join(', ')}.
        </p>
      ) : null}
      {saveState === 'error' ? <ErrorNotice error={saveError} /> : null}
      <ErrorNotice error={submit.error} />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        pending={discard.isPending}
        error={discard.error}
        onConfirm={() => discard.mutate()}
        onCancel={() => setConfirmDelete(false)}
      >
        It is removed from your Drafts, here and on your phone. This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}

/** Which sheet items each step holds, for the "required steps left" count. */
const KAIZEN_STEP_ITEMS: { items: (keyof Sheet)[] }[] = [
  { items: ['machine', 'lineArea', 'implementedOn'] },
  { items: ['teamMembers'] },
  { items: ['theme', 'target'] },
  { items: ['problem5w1h'] },
  { items: ['countermeasure'] },
  { items: ['horizontalDeployment'] },
  { items: ['benefits', 'annualSaving', 'implementationCost'] },
  { items: ['rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy'] },
];

type StepState = 'done' | 'required' | 'optional';

/** As the phone's `stepState`: required items all there ⇒ done; an optional step is done once anything in it is. */
function stepState(items: (keyof Sheet)[], missing: ReadonlySet<string>, sheet: Sheet): StepState {
  const required = items.filter((item) => REQUIRED.has(item));
  if (required.length > 0) return required.some((item) => missing.has(item)) ? 'required' : 'done';
  const filled = items.some((item) => {
    const value = sheet[item];
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== '';
  });
  return filled ? 'done' : 'optional';
}

// Ink, as on the phone: in Kaizen green means Approved and nothing else (R-48).
const STATE_CHIP: Record<StepState, { label: string; tone: string }> = {
  done: { label: '✓ Done', tone: '' },
  required: { label: 'Required', tone: '' },
  optional: { label: 'Optional', tone: 'gb-chip--muted' },
};

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children: React.ReactNode }) {
  const chip = STATE_CHIP[state];
  return (
    <Card>
      <CardHeader title={`${n}. ${title}`} action={<span className={`gb-chip ${chip.tone}`}>{chip.label}</span>} />
      <div className="space-y-4 p-4">{children}</div>
    </Card>
  );
}

function Toggles<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (value: T[]) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((option) => {
        const on = value.includes(option.value);
        return (
          <Button
            key={option.value}
            variant="secondary"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== option.value) : [...value, option.value])}
          >
            {on ? '✓ ' : ''}
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * One of the two photo boxes. Choosing a photo saves the sheet first (the photo hangs off a
 * Kaizen the server must already hold), deletes the one it replaces, then uploads: intent,
 * the PUT straight to storage, commit. The server's short-lived URL is shown once it is in.
 */
function PhotoSlot({
  kaizenId,
  kind,
  photo,
  ensureSaved,
  onChange,
}: {
  kaizenId: string;
  kind: KaizenPhotoKind;
  photo: KaizenPhoto | null;
  ensureSaved: () => Promise<void>;
  onChange: (photo: KaizenPhoto | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  const upload = useMutation({
    mutationFn: async ({ blob, live }: { blob: Blob; live: boolean }) => {
      await ensureSaved();
      if (photo) await api.delete(`/kaizens/${kaizenId}/photos/${photo.id}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const checksumSha256 = await sha256Hex(bytes);
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const photoId = uuidv7();
      const intent = await api.post<KaizenPhotoUploadIntentResponse>(
        `/kaizens/${kaizenId}/photos/upload-intent`,
        {
          id: photoId,
          kaizenId,
          kind,
          contentType: 'image/jpeg',
          byteSize: bytes.byteLength,
          checksumSha256,
          capturedAt: new Date().toISOString(),
          isLiveCapture: live,
        },
        photoId,
      );
      if (!intent.alreadyExists) await putObject(intent.uploadUrl, intent.requiredHeaders, bytes);
      await api.post(`/kaizens/${kaizenId}/photos/${intent.photoId}/commit`, { checksumSha256, ...size }, uuidv7());
      const fresh = await api.get<KaizenDetail>(`/kaizens/${kaizenId}`);
      return kind === 'BEFORE' ? fresh.beforePhoto : fresh.afterPhoto;
    },
    onMutate: ({ blob }) => setPreview(URL.createObjectURL(blob)),
    onSuccess: (saved) => onChange(saved),
    onError: () => setPreview(null),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/kaizens/${kaizenId}/photos/${photo!.id}`),
    onSuccess: () => {
      setPreview(null);
      onChange(null);
    },
  });

  const shown = preview ?? photo?.viewUrl ?? null;
  return (
    <div className="space-y-2">
      {shown ? (
        <>
          <div className="gb-kz-photo">
            <img src={shown} alt={kind === 'BEFORE' ? 'Before photograph' : 'After photograph'} referrerPolicy="no-referrer" />
          </div>
          {upload.isPending ? (
            <p className="text-sm text-ink-2" role="status">
              Uploading…
            </p>
          ) : (
            <Button variant="secondary" className="gb-btn--block" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? 'Removing…' : 'Remove photo'}
            </Button>
          )}
        </>
      ) : (
        <PhotoPicker
          photoUrl={null}
          onPhoto={(blob, live) => upload.mutate({ blob, live })}
          onRemove={() => undefined}
          hint={
            kind === 'BEFORE'
              ? 'Optional. Take one now or choose a file: an earlier photo is fine if the problem was already fixed.'
              : 'Optional. The same view as the before photo, after the fix.'
          }
        />
      )}
      <ErrorNotice error={upload.error ?? remove.error} />
    </div>
  );
}
