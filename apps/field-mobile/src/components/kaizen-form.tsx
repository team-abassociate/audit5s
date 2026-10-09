import { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KAIZEN_PARAMETERS,
  KAIZEN_WASTES,
  isoDateSchema,
  type KaizenFields,
  type KaizenParameter,
  type KaizenPhotoKind,
  type KaizenWaste,
} from '@audit5s/contracts';
import { istDateKey, missingKaizenFields } from '@audit5s/domain';
import type { ProcessedImage } from '../lib/capture/media';
import { pickFromGallery } from '../lib/capture/gallery';
import {
  addLocalKaizenPhoto,
  createLocalKaizen,
  getLocalKaizen,
  listLeaderZones,
  removeLocalKaizenPhoto,
  saveLocalKaizenFields,
  submitLocalKaizen,
  type LocalKaizen,
} from '../lib/db/kaizen.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { KAIZEN_STEPS, KAIZEN_STRINGS, type KaizenStep, type KaizenTextField } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { useSession } from '../lib/session';
import { useSync } from '../lib/sync/provider';
import { createThemedStyles } from '../lib/theme';
import { CameraCapture } from './camera-capture';
import { Button, Card, CheckRow, ChoiceList, ErrorBanner, Field, Label, Muted, SelectField, Slip, SlipText } from './ui';

/**
 * The Kaizen Sheet as a phone form (plans/kaizen-module.md §4.3): the prototype's twelve
 * collapsible steps, one open at a time.
 *
 * **Saved per field** (§3, offline-first): a text box is written to SQLite when the person
 * leaves it, a tick or a photo the moment it changes. The draft itself is created by the
 * first save, so opening the tab and leaving it creates nothing. Submit writes every field
 * once more, then refuses with the list of steps still empty — the same list the server
 * would refuse with (`missingKaizenFields`).
 *
 * Photos come from the camera or, for Kaizen, the gallery (R-48): a "before" is often
 * already on the phone, taken before anyone thought of a Kaizen.
 */

/** Which sheet fields each step holds; its required ones decide "Required" vs "Optional". */
const STEP_FIELDS: Record<KaizenStep, readonly (keyof KaizenFields)[]> = {
  details: ['machine', 'lineArea', 'implementedOn'],
  team: ['teamMembers'],
  theme: ['theme', 'target'],
  problem: ['problem5w1h'],
  countermeasure: ['countermeasure'],
  before: [],
  after: [],
  wastes: ['wastes'],
  parameters: ['parameters'],
  horizontal: ['horizontalDeployment'],
  benefits: ['benefits', 'annualSaving'],
  people: ['rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy'],
};

const TEXT_FIELDS: readonly KaizenTextField[] = [
  'machine', 'lineArea', 'implementedOn', 'teamMembers', 'theme', 'target', 'problem5w1h',
  'countermeasure', 'benefits', 'annualSaving', 'rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy',
];
const MULTILINE: ReadonlySet<KaizenTextField> = new Set([
  'teamMembers', 'problem5w1h', 'countermeasure', 'benefits', 'rootCause4m', 'analysis7qc',
]);

type Texts = Record<KaizenTextField, string>;

function textsOf(sheet: KaizenFields): Texts {
  return Object.fromEntries(
    TEXT_FIELDS.map((field) => [field, sheet[field] === null || sheet[field] === undefined ? '' : String(sheet[field])]),
  ) as Texts;
}

export function KaizenForm({ kaizenId, onSubmitted }: { kaizenId: string | null; onSubmitted: () => void }) {
  const styles = useStyles();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const { sync } = useSync();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];

  const [id, setId] = useState(kaizenId);
  // Read by `save`, so two saves in one render cannot both see "no draft yet" and make two.
  const idRef = useRef(kaizenId);
  // Saves run one at a time, so a blur and a tap together cannot both create a draft.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  // The tick lists as last written; the query cache lags a save behind on quick taps.
  const ticks = useRef<Pick<KaizenFields, 'wastes' | 'parameters'>>({});
  const [texts, setTexts] = useState<Texts | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [open, setOpen] = useState<number>(0);
  const [missingSteps, setMissingSteps] = useState<KaizenStep[]>([]);
  const [fieldError, setFieldError] = useState<Partial<Record<KaizenTextField, string>>>({});
  const [camera, setCamera] = useState<KaizenPhotoKind | null>(null);
  const scroll = useRef<ScrollView>(null);
  const stepY = useRef<number[]>([]);

  const zones = useQuery({
    queryKey: ['local', 'leader-zones', user?.id],
    queryFn: () => listLeaderZones(database, user!.id),
    enabled: Boolean(user),
  });
  const kaizen = useQuery({
    queryKey: ['local', 'kaizen', id],
    queryFn: () => getLocalKaizen(database, id!),
    enabled: id !== null,
  });

  // The text boxes start from what is saved, once; after that the person's typing is the truth.
  useEffect(() => {
    if (texts) return;
    if (id === null) setTexts({ ...textsOf({}), implementedOn: istDateKey(new Date()) ?? '' });
    else if (kaizen.data) setTexts(textsOf(kaizen.data.sheet));
  }, [id, kaizen.data, texts]);
  useEffect(() => {
    if (zoneId === null && zones.data?.[0]) setZoneId(zones.data[0].id);
  }, [zones.data, zoneId]);

  // Back over the camera closes the camera, never the form.
  useEffect(() => {
    if (!camera) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setCamera(null);
      return true;
    });
    return () => subscription.remove();
  }, [camera]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['local'] });

  /** The one write path: the first save creates the draft, every later one merges into it. */
  const save = useMutation({
    mutationFn: (fields: KaizenFields): Promise<string> => {
      const run = saving.current.then(() => write(fields));
      saving.current = run.catch(() => undefined);
      return run;
    },
    onSuccess: () => void refresh(),
  });
  async function write(fields: KaizenFields): Promise<string> {
    if (idRef.current !== null) {
      await saveLocalKaizenFields(database, idRef.current, fields);
      return idRef.current;
    }
    const zone = zones.data?.find((z) => z.id === zoneId);
    if (!zone) throw new Error(t.noZone);
    const created = await createLocalKaizen(database, {
      unitId: zone.unitId,
      zone: { id: zone.id, code: zone.code, name: zone.name },
      sheet: fields,
    });
    idRef.current = created;
    setId(created);
    return created;
  }

  const photo = useMutation({
    mutationFn: async ({ kind, image, live }: { kind: KaizenPhotoKind; image: ProcessedImage; live: boolean }) => {
      const kaizenId = await save.mutateAsync(pendingTextFields() ?? {});
      await addLocalKaizenPhoto(database, {
        kaizenId,
        kind,
        localFileUri: image.uri,
        byteSize: image.byteSize,
        checksumSha256: image.checksumSha256,
        width: image.width,
        height: image.height,
        isLiveCapture: live,
      });
    },
    onSuccess: () => {
      setCamera(null);
      void refresh();
    },
  });
  const gallery = useMutation({
    mutationFn: async (kind: KaizenPhotoKind) => {
      const image = await pickFromGallery();
      if (image) await photo.mutateAsync({ kind, image, live: false });
    },
  });
  const removePhoto = useMutation({
    mutationFn: (photoId: string) => removeLocalKaizenPhoto(database, photoId),
    onSuccess: () => void refresh(),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const kaizenId = await save.mutateAsync(pendingTextFields() ?? {});
      const saved = await getLocalKaizen(database, kaizenId);
      const missing = new Set(missingKaizenFields(saved?.sheet ?? {}));
      const steps = KAIZEN_STEPS.filter((step) => STEP_FIELDS[step].some((field) => missing.has(field as never)));
      setMissingSteps(steps);
      if (steps.length > 0) {
        setOpen(KAIZEN_STEPS.indexOf(steps[0]!));
        scroll.current?.scrollTo({ y: 0, animated: true });
        return false;
      }
      await submitLocalKaizen(database, kaizenId);
      return true;
    },
    onSuccess: (submitted) => {
      if (!submitted) return;
      void refresh();
      void sync();
      onSubmitted();
    },
  });

  /** A text box's value as the sheet stores it; `undefined` ⇒ it cannot be saved as typed. */
  function parse(field: KaizenTextField, raw: string): KaizenFields[KaizenTextField] | undefined {
    const value = raw.trim();
    if (value === '') return null;
    if (field === 'implementedOn') return isoDateSchema.safeParse(value).success ? value : undefined;
    if (field === 'annualSaving') {
      const rupees = Number(value.replace(/[₹,\s]/g, ''));
      return Number.isFinite(rupees) && rupees >= 0 ? rupees : undefined;
    }
    return value;
  }

  /** Every text box whose value differs from what is saved — Submit's last flush. */
  function pendingTextFields(): KaizenFields | null {
    if (!texts) return null;
    const saved = kaizen.data?.sheet ?? {};
    const fields: KaizenFields = {};
    for (const field of TEXT_FIELDS) {
      const value = parse(field, texts[field]);
      if (value === undefined || value === (saved[field] ?? null)) continue;
      (fields as Record<string, unknown>)[field] = value;
    }
    return fields;
  }

  function commitText(field: KaizenTextField) {
    if (!texts) return;
    const value = parse(field, texts[field]);
    if (value === undefined) {
      setFieldError((errors) => ({ ...errors, [field]: field === 'implementedOn' ? t.badDate : t.badSaving }));
      return;
    }
    setFieldError((errors) => ({ ...errors, [field]: undefined }));
    // Unchanged — and on a form with no draft yet, an empty box creates nothing.
    if (value === ((kaizen.data?.sheet ?? {})[field] ?? null)) return;
    save.mutate({ [field]: value });
  }

  if (camera) {
    return (
      <>
        <Stack.Screen
          options={{ headerLeft: ({ tintColor }) => <HeaderBackButton tintColor={tintColor} onPress={() => setCamera(null)} /> }}
        />
        <CameraCapture
          prompt={t.cameraPrompt(camera)}
          onCaptured={(image) => photo.mutateAsync({ kind: camera, image, live: true })}
          onCancel={() => setCamera(null)}
        />
      </>
    );
  }
  if (!texts) return null;
  if (id === null && zones.data && zones.data.length === 0) {
    return <Slip title={t.noZone} />;
  }

  const current: LocalKaizen | null = kaizen.data ?? null;
  const sheet: KaizenFields = { ...current?.sheet, ...ticks.current };
  const resubmitting = current?.status === 'SENT_BACK';
  const missingNow = new Set(missingKaizenFields({ ...sheet, ...pendingTextFields() }));
  const stepState = (step: KaizenStep): 'done' | 'required' | 'optional' => {
    const fields = STEP_FIELDS[step];
    if (step === 'before' || step === 'after') return current?.[step] ? 'done' : 'optional';
    if (step === 'wastes' || step === 'parameters') return (sheet[step]?.length ?? 0) > 0 ? 'done' : 'optional';
    const required = fields.filter(isRequired);
    if (required.length === 0) return 'optional';
    return required.some((field) => missingNow.has(field as never)) ? 'required' : 'done';
  };

  const toggle = <T extends string>(field: 'wastes' | 'parameters', value: T) => {
    const list = (ticks.current[field] ?? sheet[field] ?? []) as readonly string[];
    const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    ticks.current = { ...ticks.current, [field]: next };
    save.mutate({ [field]: next } as KaizenFields);
  };

  const textField = (field: KaizenTextField) => (
    <Field
      key={field}
      testID={`kaizen-${field}`}
      label={t.field[field]}
      value={texts[field]}
      multiline={MULTILINE.has(field)}
      keyboardType={field === 'annualSaving' ? 'decimal-pad' : field === 'implementedOn' ? 'numbers-and-punctuation' : 'default'}
      {...(fieldError[field] ? { error: fieldError[field] } : {})}
      onChangeText={(value) => setTexts((all) => (all ? { ...all, [field]: value } : all))}
      onBlur={() => commitText(field)}
    />
  );

  const photoStep = (kind: KaizenPhotoKind) => {
    const shown = kind === 'BEFORE' ? current?.before : current?.after;
    return (
      <>
        {shown?.localFileUri ? (
          <Image source={{ uri: shown.localFileUri }} style={styles.photo} accessibilityLabel={kind === 'BEFORE' ? t.before : t.after} />
        ) : shown ? (
          <View style={styles.placeholder}>
            <Muted>{t.photoOnline}</Muted>
          </View>
        ) : null}
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <Button title={shown ? t.retakePhoto : t.takePhoto} variant="secondary" onPress={() => setCamera(kind)} />
          </View>
          <View style={styles.flex}>
            <Button title={t.fromGallery} variant="secondary" busy={gallery.isPending} onPress={() => gallery.mutate(kind)} />
          </View>
        </View>
        {shown ? (
          <Button title={t.removePhoto} variant="secondary" busy={removePhoto.isPending} onPress={() => removePhoto.mutate(shown.id)} />
        ) : null}
      </>
    );
  };

  const body = (step: KaizenStep) => {
    switch (step) {
      case 'details':
        return (
          <>
            {id === null && (zones.data?.length ?? 0) > 1 ? (
              <SelectField
                label={t.zone}
                options={(zones.data ?? []).map((z) => ({ value: z.id, label: `${z.code} · ${z.name}` }))}
                value={zoneId}
                onChange={setZoneId}
              />
            ) : null}
            {textField('machine')}
            {textField('lineArea')}
            {textField('implementedOn')}
          </>
        );
      case 'team':
        return textField('teamMembers');
      case 'theme':
        return (
          <>
            {textField('theme')}
            {textField('target')}
          </>
        );
      case 'problem':
        return textField('problem5w1h');
      case 'countermeasure':
        return textField('countermeasure');
      case 'before':
        return photoStep('BEFORE');
      case 'after':
        return photoStep('AFTER');
      case 'wastes':
        return KAIZEN_WASTES.map((waste: KaizenWaste, index) => (
          <CheckRow
            key={waste}
            label={`${index + 1}. ${t.waste[waste]}`}
            checked={sheet.wastes?.includes(waste) ?? false}
            onChange={() => toggle('wastes', waste)}
          />
        ));
      case 'parameters':
        return KAIZEN_PARAMETERS.map((parameter: KaizenParameter) => (
          <CheckRow
            key={parameter}
            label={t.parameter[parameter]}
            checked={sheet.parameters?.includes(parameter) ?? false}
            onChange={() => toggle('parameters', parameter)}
          />
        ));
      case 'horizontal':
        return (
          <>
            <Label>{t.horizontalQuestion}</Label>
            <ChoiceList
              options={[
                { value: 'yes', label: t.yes },
                { value: 'no', label: t.no },
              ]}
              value={sheet.horizontalDeployment === true ? 'yes' : sheet.horizontalDeployment === false ? 'no' : null}
              onChange={(value) => save.mutate({ horizontalDeployment: value === 'yes' })}
            />
          </>
        );
      case 'benefits':
        return (
          <>
            {textField('benefits')}
            {textField('annualSaving')}
          </>
        );
      case 'people':
        return (
          <>
            {textField('rootCause4m')}
            {textField('analysis7qc')}
            {textField('ideaBy')}
            {textField('implementedBy')}
          </>
        );
    }
  };

  const submitTitle = resubmitting ? t.resubmit : t.submit;
  const error = submit.error ?? save.error ?? photo.error ?? gallery.error ?? removePhoto.error;

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {resubmitting && current?.reviewComment ? (
        <Slip title={`${t.status.SENT_BACK} · ${t.coordinator}`}>
          <SlipText>{current.reviewComment}</SlipText>
        </Slip>
      ) : null}
      {missingSteps.length > 0 ? (
        <Slip title={t.fillThese}>
          <SlipText>{missingSteps.map((step) => t.step[step]).join(' · ')}</SlipText>
        </Slip>
      ) : null}
      <Muted>{t.savedAsYouGo}</Muted>

      {KAIZEN_STEPS.map((step, index) => {
        const isOpen = open === index;
        const state = stepState(step);
        return (
          <View
            key={step}
            style={styles.step}
            onLayout={(event) => {
              stepY.current[index] = event.nativeEvent.layout.y;
            }}
          >
            <Card style={styles.stepCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
                onPress={() => setOpen(isOpen ? -1 : index)}
                style={styles.stepHead}
              >
                <Text style={styles.stepNo}>{String(index + 1).padStart(2, '0')}</Text>
                <Text style={styles.stepTitle}>{t.step[step]}</Text>
                <Text style={[styles.stepState, state === 'done' && styles.stepDone]}>
                  {state === 'done' ? t.done : state === 'required' ? t.required : t.optional}
                </Text>
              </Pressable>
              {isOpen ? (
                <View style={styles.stepBody}>
                  {body(step)}
                  {index < KAIZEN_STEPS.length - 1 ? (
                    <Button
                      title={t.next}
                      variant="secondary"
                      onPress={() => {
                        setOpen(index + 1);
                        const y = stepY.current[index];
                        if (y !== undefined) setTimeout(() => scroll.current?.scrollTo({ y, animated: true }), 60);
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
            </Card>
          </View>
        );
      })}

      <ErrorBanner message={error?.message ?? null} />
      <Button testID="kaizen-submit" title={submitTitle} busy={submit.isPending} onPress={() => submit.mutate()} />
    </ScrollView>
  );
}

/** Whether a sheet field must be filled before Submit (`KAIZEN_REQUIRED_FIELDS`). */
function isRequired(field: keyof KaizenFields): boolean {
  return missingKaizenFields({}).includes(field as never);
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.lg, paddingBottom: theme.space.xl * 2, gap: theme.space.sm },
  step: {},
  stepCard: { paddingVertical: 0 },
  stepHead: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: theme.space.sm },
  stepNo: { width: 24, fontFamily: theme.family.mono, fontSize: 12.5, color: theme.color.ink2 },
  stepTitle: {
    flex: 1,
    fontFamily: theme.family.bold,
    fontSize: theme.font.base,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: theme.color.ink,
  },
  stepState: { fontFamily: theme.family.medium, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: theme.color.ink3 },
  // Ink, not green: green is Approved and nothing else in Kaizen (owner, 2026-10-07).
  stepDone: { color: theme.color.ink },
  stepBody: { paddingBottom: theme.space.md, gap: theme.space.sm },
  photo: { width: '100%', aspectRatio: 4 / 3, borderWidth: 1.5, borderColor: theme.color.edge, backgroundColor: theme.color.tile2 },
  placeholder: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  buttons: { flexDirection: 'row', gap: theme.space.sm },
  flex: { flex: 1 },
}));
