import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import { DateTimePickerAndroid } from '../lib/date-dialog';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KAIZEN_PARAMETERS,
  KAIZEN_REQUIRED_FIELDS,
  KAIZEN_WASTES,
  isoDateSchema,
  type KaizenFields,
  type KaizenParameter,
  type KaizenPhotoKind,
  type KaizenRequiredField,
  type KaizenWaste,
  type Page,
  type Unit,
  type Zone,
} from '@audit5s/contracts';
import { formatDate, istDateKey, zoneDisplayLabel } from '@audit5s/domain';
import { api } from '../lib/api';
import { discardProcessedPhoto, type ProcessedImage } from '../lib/capture/media';
import { pickFromGallery } from '../lib/capture/gallery';
import { listLocalUnits, listLocalZones } from '../lib/db/catalogue.repository';
import {
  addLocalKaizenPhoto,
  createLocalKaizen,
  discardLocalKaizen,
  getLocalKaizen,
  removeLocalKaizenPhoto,
  saveLocalKaizenFields,
  saveLocalKaizenZone,
  submitLocalKaizen,
  type LocalKaizen,
} from '../lib/db/kaizen.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { KAIZEN_STEPS, KAIZEN_STRINGS, type KaizenStep, type KaizenTextField } from '../lib/kaizen-strings';
import { haptic } from '../lib/haptics';
import { formProgress, stepOf } from '../lib/kaizen-steps';
import { useLanguage } from '../lib/language-provider';
import { fadeIn, transition } from '../lib/motion';
import { useRequiredFields } from '../lib/required-fields';
import { useSession } from '../lib/session';
import { useSync } from '../lib/sync/provider';
import { createThemedStyles, tabBarStyle, useTheme } from '../lib/theme';
import { CameraCapture } from './camera-capture';
import { KaizenPhotoEditor } from './kaizen-photo-editor';
import { KaizenPhotoViewer } from './kaizen-photo-viewer';
import {
  Button,
  Card,
  CheckRow,
  ChoiceList,
  ConfirmAction,
  ErrorBanner,
  Field,
  Label,
  Muted,
  SelectField,
  Slip,
  SlipText,
} from './ui';

/**
 * The Kaizen Sheet as a phone form (plans/kaizen-module.md §4.3): the prototype's twelve
 * collapsible steps, one open at a time, in the order of the client's paper sheet.
 *
 * **Saved per field** (§3, offline-first): a text box is written to SQLite when the person
 * leaves it, 800 ms after they stop typing, and when the app goes to the background or the
 * form closes; a tick or a photo the moment it changes. The draft itself is created by the
 * first save, so opening the tab and leaving it creates nothing.
 *
 * **Progress** is a strip pinned above the steps, so how far along it is is always in view;
 * **Submit** is the last thing on the form, after every step (owner, 2026-10-10). Pressed with something missing, it opens the first
 * step with a gap, marks every missing box red, scrolls to it and focuses it, the way every
 * other form in the app does (`useRequiredFields`), and names them all in a banner. The list
 * is `missingKaizenFields`: the boxes the server requires. Photos are optional (owner, 2026-10-11).
 *
 * Photos come from the camera or, for Kaizen, the gallery (R-48): a "before" is often
 * already on the phone, taken before anyone thought of a Kaizen. Either way it opens in the
 * editor first, to crop, rotate or highlight it (owner, 2026-11-06).
 *
 * A Kaizen is filed under a Zone of the person's Unit, a typed department, or both (R-88). The
 * Zone may change while the sheet is editable; the server renumbers it to match.
 */

const TEXT_FIELDS: readonly KaizenTextField[] = [
  'department', 'machine', 'lineArea', 'implementedOn', 'teamMembers', 'theme', 'target', 'problem5w1h',
  'countermeasure', 'benefits', 'annualSaving', 'implementationCost', 'rootCause4m', 'analysis7qc', 'ideaBy', 'implementedBy',
];
const MULTILINE: ReadonlySet<KaizenTextField> = new Set([
  'teamMembers', 'problem5w1h', 'countermeasure', 'benefits', 'rootCause4m', 'analysis7qc',
]);
/** Rupee boxes: a number pad, and 0 is a real answer. */
const RUPEES: ReadonlySet<KaizenTextField> = new Set(['annualSaving', 'implementationCost']);
/** Text boxes the server requires: these carry `useRequiredFields`' ref and red state. */
const REQUIRED_TEXT: ReadonlySet<string> = new Set(KAIZEN_REQUIRED_FIELDS);
/** Quiet time after the last keystroke before a box is saved (plan 2.4). */
const TYPING_SAVE_MS = 800;

type Texts = Record<KaizenTextField, string>;

function textsOf(sheet: KaizenFields): Texts {
  return Object.fromEntries(
    TEXT_FIELDS.map((field) => [field, sheet[field] === null || sheet[field] === undefined ? '' : String(sheet[field])]),
  ) as Texts;
}

export function KaizenForm({
  kaizenId,
  onSubmitted,
  onDiscarded,
}: {
  kaizenId: string | null;
  onSubmitted: (kaizenId: string, resubmitted: boolean) => void;
  onDiscarded: () => void;
}) {
  const styles = useStyles();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user, scope } = useSession();
  const router = useRouter();
  const { sync } = useSync();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  // R-85: a Super Admin files a Kaizen under any Zone of any Unit, and picks both.
  const anyUnit = scope?.role === 'SUPER_ADMIN';

  const [id, setId] = useState(kaizenId);
  // Read by `save`, so two saves in one render cannot both see "no draft yet" and make two.
  const idRef = useRef(kaizenId);
  // Saves run one at a time, so a blur and a tap together cannot both create a draft.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  // The tick lists as last written; the query cache lags a save behind on quick taps.
  const ticks = useRef<Pick<KaizenFields, 'wastes' | 'parameters'>>({});
  const [texts, setTexts] = useState<Texts | null>(null);
  // The latest typing, for a save that fires after this render (a timer, the app leaving).
  const textsRef = useRef<Texts | null>(null);
  textsRef.current = texts;
  // Boxes typed in since they were last saved: what a flush writes. Never the prefills alone.
  const dirty = useRef(new Set<KaizenTextField>());
  const timers = useRef(new Map<KaizenTextField, ReturnType<typeof setTimeout>>());
  const [unitId, setUnitId] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  // For a save queued before the next render.
  const zoneRef = useRef(zoneId);
  const [open, setOpen] = useState<number>(0);
  const [attempted, setAttempted] = useState(false);
  const [fieldError, setFieldError] = useState<Partial<Record<KaizenTextField, string>>>({});
  const [camera, setCamera] = useState<KaizenPhotoKind | null>(null);
  const [viewing, setViewing] = useState<KaizenPhotoKind | null>(null);
  // A photo in the editor. `fresh` is the one just taken or picked, not yet on the sheet.
  const [editing, setEditing] = useState<{
    kind: KaizenPhotoKind;
    source: { uri: string; width: number; height: number };
    fresh: ProcessedImage | null;
    live: boolean;
  } | null>(null);
  const required = useRequiredFields<KaizenRequiredField>();
  // What waits for a step to lay out after it opens: Next's scroll, or a refused Submit's reveal.
  const afterOpen = useRef<{ index: number; run: (y: number) => void } | null>(null);
  const scroller = useRef<ScrollView | null>(null);
  const reduced = useReducedMotion();

  const kaizen = useQuery({
    queryKey: ['local', 'kaizen', id],
    queryFn: () => getLocalKaizen(database, id!),
    enabled: id !== null,
  });
  // M-1 gives everyone but a Super Admin one Unit; a Super Admin picks it, and it stays.
  const filedUnit = kaizen.data?.unitId ?? (anyUnit ? unitId : (scope?.unitIds[0] ?? null));
  // A Unit made a moment ago is on the server before it is in the phone's catalogue, so the
  // server answers first. Offline, the catalogue does.
  const units = useQuery({
    queryKey: ['kaizen-form', 'units'],
    queryFn: () =>
      api
        .get<Page<Unit>>('/units?limit=200')
        .then((page) => page.data.map((unit) => ({ id: unit.id, name: unit.name })))
        .catch(() => listLocalUnits(database)),
    enabled: anyUnit && kaizenId === null,
  });
  const unitZones = useQuery({
    queryKey: ['kaizen-form', 'zones', filedUnit],
    queryFn: () =>
      api
        .get<Page<Zone>>(`/units/${filedUnit}/zones?active=true&limit=200`)
        .then((page) => page.data.map(({ id: zone, unitId: unit, code, name }) => ({ id: zone, unitId: unit, code, name })))
        .catch(() => listLocalZones(database, filedUnit!)),
    enabled: filedUnit !== null,
  });
  const zoneOptions = unitZones.data;
  // Back from adding a Unit or a Zone, the lists show it.
  useFocusEffect(
    useCallback(() => {
      if (anyUnit) void queryClient.invalidateQueries({ queryKey: ['kaizen-form'] });
    }, [anyUnit, queryClient]),
  );
  // The latest saved sheet, for the same late saves.
  const savedRef = useRef<KaizenFields>({});
  savedRef.current = kaizen.data?.sheet ?? {};

  // The text boxes start from what is saved, once; after that the person's typing is the truth.
  // A new one starts with today's date and the leader as both people (plan 1.6): nearly always
  // right, and saved with the draft's first real change, never just by opening the form.
  useEffect(() => {
    if (texts) return;
    if (id === null) {
      setTexts({
        ...textsOf({}),
        implementedOn: istDateKey(new Date()) ?? '',
        // A Super Admin records it for someone else's Zone, so their own name would be wrong.
        ideaBy: anyUnit ? '' : (user?.fullName ?? ''),
        implementedBy: anyUnit ? '' : (user?.fullName ?? ''),
      });
    } else if (kaizen.data) {
      setTexts(textsOf(kaizen.data.sheet));
      zoneRef.current = kaizen.data.zoneId || null;
      setZoneId(zoneRef.current);
    }
  }, [anyUnit, id, kaizen.data, texts, user]);

  // The camera is the whole screen: no tab bar under it (the form is also mounted in a
  // stack, which has none), and the header's arrow closes the camera. Both are put back when
  // it closes, so the arrow never outlives the camera as a dead button.
  const navigation = useNavigation();
  const theme = useTheme();
  useEffect(() => {
    navigation.setOptions({
      tabBarStyle: camera ? { display: 'none' } : tabBarStyle(theme),
      headerLeft: camera
        ? ({ tintColor }: { tintColor?: string }) => <HeaderBackButton tintColor={tintColor} onPress={() => setCamera(null)} />
        : undefined,
    });
  }, [camera, navigation, theme]);

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
  function persist(fields: KaizenFields): Promise<string> {
    const run = saving.current.then(() => write(fields));
    saving.current = run.catch(() => undefined);
    return run;
  }
  const save = useMutation({ mutationFn: persist, onSuccess: () => void refresh() });
  /** Saved the moment it is chosen, like a tick. In the same queue, so it cannot make a second draft. */
  const refile = useMutation({
    mutationFn: async (chosen: string | null) => {
      if (chosen === zoneRef.current) return;
      zoneRef.current = chosen;
      setZoneId(chosen);
      const zone = zoneOptions?.find((z) => z.id === chosen);
      const run = saving.current.then(async () => {
        if (idRef.current === null) await write({});
        else await saveLocalKaizenZone(database, idRef.current, zone ? { id: zone.id, code: zone.code, name: zone.name } : null);
      });
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
    if (!filedUnit) throw new Error(t.noZone);
    const zone = zoneOptions?.find((z) => z.id === zoneRef.current);
    // The draft is born with the prefilled date and names too, not only the box that made it
    // (Phase 0.1: a draft started from Machine reopened with no date).
    const created = await createLocalKaizen(database, {
      unitId: filedUnit,
      zone: zone ? { id: zone.id, code: zone.code, name: zone.name } : null,
      sheet: { ...pendingTextFields(), ...fields },
    });
    idRef.current = created;
    setId(created);
    return created;
  }

  /**
   * Writes every box typed in and not yet saved. Runs when the app leaves the foreground and
   * when the form closes: a box still focused then has had no blur to save it (Phase 0.1).
   */
  const flushRef = useRef(() => {});
  flushRef.current = () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    const fields: KaizenFields = {};
    for (const field of dirty.current) {
      const value = parse(field, textsRef.current?.[field] ?? '');
      if (value !== undefined && value !== (savedRef.current[field] ?? null)) {
        (fields as Record<string, unknown>)[field] = value;
      }
    }
    dirty.current.clear();
    if (Object.keys(fields).length > 0) void persist(fields).then(refresh, () => undefined);
  };
  const flush = useCallback(() => flushRef.current(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [flush]);

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
      if (image) setEditing({ kind, source: image, fresh: image, live: false });
    },
  });
  const removePhoto = useMutation({
    mutationFn: (photoId: string) => removeLocalKaizenPhoto(database, photoId),
    onSuccess: () => void refresh(),
  });
  const discard = useMutation({
    mutationFn: async () => {
      // Nothing typed may land on it afterwards.
      for (const timer of timers.current.values()) clearTimeout(timer);
      dirty.current.clear();
      await saving.current;
      await discardLocalKaizen(database, idRef.current!);
    },
    onSuccess: () => {
      void refresh();
      void sync();
      onDiscarded();
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const kaizenId = await save.mutateAsync(pendingTextFields() ?? {});
      dirty.current.clear();
      const saved = await getLocalKaizen(database, kaizenId);
      const { missing } = formProgress(
        { ...saved?.sheet, zoneId: saved?.zoneId ?? null },
        { before: Boolean(saved?.before), after: Boolean(saved?.after) },
      );
      if (missing.size > 0) {
        refuse([...missing] as KaizenRequiredField[]);
        return null;
      }
      await submitLocalKaizen(database, kaizenId);
      return { kaizenId, resubmitted: saved?.status === 'SENT_BACK' };
    },
    onSuccess: (done) => {
      if (!done) return;
      haptic.submitted();
      void refresh();
      void sync();
      onSubmitted(done.kaizenId, done.resubmitted);
    },
  });

  /** A refused Submit: open the first step with a gap, then show and focus its first box. */
  function refuse(missing: KaizenRequiredField[]) {
    haptic.refused();
    setAttempted(true);
    const index = KAIZEN_STEPS.indexOf(stepOf(missing[0]!));
    const reveal = () => required.check(missing.map((item) => [item, false] as const));
    if (open === index) {
      requestAnimationFrame(reveal);
    } else {
      // A closed step's boxes are not mounted: reveal once it has laid out.
      afterOpen.current = { index, run: reveal };
      setOpen(index);
    }
  }

  /** A text box's value as the sheet stores it; `undefined` ⇒ it cannot be saved as typed. */
  function parse(field: KaizenTextField, raw: string): KaizenFields[KaizenTextField] | undefined {
    const value = raw.trim();
    if (value === '') return null;
    if (field === 'implementedOn') return isoDateSchema.safeParse(value).success ? value : undefined;
    if (RUPEES.has(field)) {
      const rupees = Number(value.replace(/[₹,\s]/g, ''));
      return Number.isFinite(rupees) && rupees >= 0 ? rupees : undefined;
    }
    return value;
  }

  /** Every text box whose value differs from what is saved: Submit's last flush. */
  function pendingTextFields(): KaizenFields | null {
    const current = textsRef.current;
    if (!current) return null;
    const fields: KaizenFields = {};
    for (const field of TEXT_FIELDS) {
      const value = parse(field, current[field]);
      if (value === undefined || value === (savedRef.current[field] ?? null)) continue;
      (fields as Record<string, unknown>)[field] = value;
    }
    return fields;
  }

  /** Saves one box. `quiet` (the typing pause): a half-typed date waits for the blur to complain. */
  function commitText(field: KaizenTextField, quiet = false) {
    clearTimeout(timers.current.get(field));
    timers.current.delete(field);
    const raw = textsRef.current?.[field];
    if (raw === undefined) return;
    const value = parse(field, raw);
    if (value === undefined) {
      if (!quiet) setFieldError((errors) => ({ ...errors, [field]: t.badSaving }));
      return;
    }
    setFieldError((errors) => ({ ...errors, [field]: undefined }));
    dirty.current.delete(field);
    // Unchanged, and on a form with no draft yet, an empty box creates nothing.
    if (value === (savedRef.current[field] ?? null)) return;
    save.mutate({ [field]: value });
  }

  if (camera) {
    return (
      <CameraCapture
        prompt={t.cameraPrompt(camera)}
        onCaptured={(image) => {
          haptic.captured();
          setEditing({ kind: camera, source: image, fresh: image, live: true });
          setCamera(null);
        }}
        onCancel={() => setCamera(null)}
      />
    );
  }
  if (!texts) return null;
  if (!anyUnit && id === null && filedUnit === null) {
    return <Slip title={t.noZone} />;
  }

  // Which Unit: a Super Admin's list, whether first or back in the sheet's first step.
  const filing = (
    <SelectField
      label={t.unit}
      searchable
      options={(units.data ?? []).map((unit) => ({ value: unit.id, label: unit.name }))}
      value={unitId}
      onChange={(value) => {
        setUnitId(value);
        zoneRef.current = null;
        setZoneId(null);
      }}
    />
  );
  // The sheet opens once it has somewhere to be filed.
  if (anyUnit && id === null && unitId === null) {
    return (
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          <Label>{t.chooseFiling}</Label>
          {filing}
        </Card>
        {units.data?.length === 0 ? (
          <>
            <Slip title={t.noUnits} />
            <Button title={t.newUnit} icon="add" onPress={() => router.push('/manage/new-unit')} />
          </>
        ) : null}
      </ScrollView>
    );
  }

  const current: LocalKaizen | null = kaizen.data ?? null;
  const sheet: KaizenFields = { ...current?.sheet, ...ticks.current, ...pendingTextFields() };
  const resubmitting = current?.status === 'SENT_BACK';
  const progress = formProgress({ ...sheet, zoneId }, { before: Boolean(current?.before), after: Boolean(current?.after) });
  const { missing } = progress;
  const missingNames = [...missing].map((item) =>
    item === 'horizontalDeployment'
      ? t.step.horizontal
      : item === 'zoneOrDepartment'
        ? t.zoneOrDepartment
        : t.field[item as KaizenTextField],
  );

  const toggle = <T extends string>(field: 'wastes' | 'parameters', value: T) => {
    const list = (ticks.current[field] ?? sheet[field] ?? []) as readonly string[];
    const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    ticks.current = { ...ticks.current, [field]: next };
    save.mutate({ [field]: next } as KaizenFields);
  };

  const textField = (field: KaizenTextField) => {
    // The department box stands for the either-or rule: a refused Submit lands on it.
    const item = (field === 'department' ? 'zoneOrDepartment' : field) as KaizenRequiredField;
    const isRequired = REQUIRED_TEXT.has(item);
    const hint = t.hint[field];
    const message = field === 'department' ? t.zoneOrDepartmentError : t.requiredError;
    const error = fieldError[field] ?? (isRequired ? required.error(item, message, !missing.has(item)) : undefined);
    return (
      <Field
        key={field}
        testID={`kaizen-${field}`}
        label={t.field[field]}
        value={texts[field]}
        multiline={MULTILINE.has(field)}
        keyboardType={RUPEES.has(field) ? 'decimal-pad' : 'default'}
        {...(isRequired ? { inputRef: required.input(item) } : {})}
        {...(hint ? { hint } : {})}
        {...(error ? { error } : {})}
        onChangeText={(value) => {
          setTexts((all) => (all ? { ...all, [field]: value } : all));
          dirty.current.add(field);
          clearTimeout(timers.current.get(field));
          timers.current.set(field, setTimeout(() => commitText(field, true), TYPING_SAVE_MS));
        }}
        onBlur={() => commitText(field)}
      />
    );
  };

  /**
   * The date from Android's own calendar (#10), never typed: it cannot be in the future or
   * malformed. Stored as before, `YYYY-MM-DD` in IST. Saved the moment it is set, like a tick.
   */
  const dateField = () => {
    const value = texts.implementedOn;
    const label = t.field.implementedOn;
    return (
      <Pressable
        testID="kaizen-implementedOn"
        accessibilityRole="button"
        accessibilityLabel={value ? `${label}: ${formatDate(value)}` : label}
        onPress={() =>
          DateTimePickerAndroid.open({
            // Noon in IST, so the day it shows is the day stored, whatever the phone's zone.
            value: value ? new Date(`${value}T12:00:00+05:30`) : new Date(),
            mode: 'date',
            maximumDate: new Date(),
            onChange: (event, date) => {
              const key = event.type === 'set' && date ? istDateKey(date) : null;
              if (!key) return;
              setTexts((all) => (all ? { ...all, implementedOn: key } : all));
              if (key !== (savedRef.current.implementedOn ?? null)) save.mutate({ implementedOn: key });
            },
          })
        }
      >
        {/* The text box's own look, so it reads as one more box on the form. */}
        <View pointerEvents="none">
          <Field label={label} value={value ? formatDate(value) : ''} editable={false} />
        </View>
      </Pressable>
    );
  };

  const photoStep = (kind: KaizenPhotoKind) => {
    const shown = kind === 'BEFORE' ? current?.before : current?.after;
    return (
      <View style={styles.photoStep}>
        {shown?.localFileUri ? (
          <Pressable accessibilityRole="imagebutton" accessibilityLabel={t.openPhoto(kind)} onPress={() => setViewing(kind)}>
            <Image source={{ uri: shown.localFileUri }} style={styles.photo} />
          </Pressable>
        ) : shown ? (
          <View style={styles.placeholder}>
            <Muted>{t.photoOnline}</Muted>
          </View>
        ) : (
          <Text style={styles.photoHint}>{kind === 'BEFORE' ? t.beforeHint : t.afterHint}</Text>
        )}
        {shown?.localFileUri && shown.width && shown.height ? (
          <Button
            title={t.editPhoto}
            icon="edit"
            variant="secondary"
            onPress={() =>
              setEditing({
                kind,
                source: { uri: shown.localFileUri!, width: shown.width!, height: shown.height! },
                fresh: null,
                live: shown.isLiveCapture === 1,
              })
            }
          />
        ) : null}
        {/* Camera or gallery, side by side, always: either is fine for a Kaizen (R-48). */}
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <Button
              title={shown ? t.retakePhoto : t.takePhoto}
              icon="photo-camera"
              variant={shown ? 'secondary' : 'primary'}
              onPress={() => setCamera(kind)}
            />
          </View>
          <View style={styles.flex}>
            <Button title={t.fromGallery} icon="photo-library" variant="secondary" busy={gallery.isPending} onPress={() => gallery.mutate(kind)} />
          </View>
        </View>
        {shown ? (
          <ConfirmAction
            title={t.removePhoto}
            icon="delete"
            question={t.removePhotoQuestion(kind)}
            confirmLabel={t.removePhoto}
            keepLabel={t.keep}
            busy={removePhoto.isPending}
            onConfirm={() => {
              haptic.destroyed();
              removePhoto.mutate(shown.id);
            }}
          />
        ) : null}
      </View>
    );
  };

  const body = (step: KaizenStep) => {
    switch (step) {
      case 'details':
        return (
          <>
            {anyUnit && id === null ? filing : null}
            <SelectField
              label={t.zoneOptional}
              searchable
              options={[
                { value: '', label: t.noZoneChoice },
                // Its own Zone stays on the list even if since archived, or the list is offline.
                ...(current?.zoneId && !zoneOptions?.some((z) => z.id === current.zoneId)
                  ? [{ value: current.zoneId, label: zoneDisplayLabel(current.zoneCode, current.zoneName) }]
                  : []),
                ...(zoneOptions ?? []).map((z) => ({ value: z.id, label: zoneDisplayLabel(z.code, z.name) })),
              ]}
              value={zoneId}
              onChange={(value) => refile.mutate(value || null)}
            />
            {textField('department')}
            {textField('machine')}
            {textField('lineArea')}
            {dateField()}
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
          <View ref={required.anchor('horizontalDeployment')} collapsable={false}>
            <Label>{t.horizontalQuestion}</Label>
            <ChoiceList
              options={[
                { value: 'yes', label: t.yes },
                { value: 'no', label: t.no },
              ]}
              value={sheet.horizontalDeployment === true ? 'yes' : sheet.horizontalDeployment === false ? 'no' : null}
              onChange={(value) => save.mutate({ horizontalDeployment: value === 'yes' })}
            />
            {required.flagged('horizontalDeployment', !missing.has('horizontalDeployment')) ? (
              <Text style={styles.missingNote}>{t.requiredError}</Text>
            ) : null}
          </View>
        );
      case 'benefits':
        return (
          <>
            {textField('benefits')}
            {textField('annualSaving')}
            {textField('implementationCost')}
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
  const error = submit.error ?? save.error ?? refile.error ?? photo.error ?? gallery.error ?? removePhoto.error ?? discard.error;
  const ready = progress.requiredLeft === 0;

  return (
    <View style={styles.column}>
      <View style={styles.progressStrip}>
        <Text style={styles.progressText}>
          {t.progress(progress.done, progress.total)} · {ready ? t.readyToSubmit : t.requiredLeft(progress.requiredLeft)}
        </Text>
        <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {/* M5: the step it gains slides in over the one motion; reduced motion makes it instant. */}
          <Animated.View
            style={[
              styles.meterFill,
              { transform: [{ scaleX: progress.done / progress.total }], transitionProperty: 'transform', ...transition },
              reduced && { transitionDuration: 0 },
            ]}
          />
        </View>
      </View>
      <ScrollView
        ref={(node) => {
          scroller.current = node;
          required.scroll(node);
        }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* The one slip: the Coordinator's reason. A refused Submit is a banner (S3). */}
        {resubmitting && current?.reviewComment ? (
          <Slip title={`${t.status.SENT_BACK} · ${t.coordinator}`}>
            <SlipText>{current.reviewComment}</SlipText>
          </Slip>
        ) : null}
        <ErrorBanner message={attempted && missingNames.length > 0 ? t.missingBanner(missingNames.length, missingNames.join(', ')) : null} />
        <Muted>{t.savedAsYouGo}</Muted>

        {KAIZEN_STEPS.map((step, index) => {
          const isOpen = open === index;
          const state = progress.states[index]!;
          const flagged = attempted && state === 'required';
          return (
            <View
              key={step}
              onLayout={(event) => {
                const waiting = afterOpen.current;
                if (!waiting || waiting.index !== index || !isOpen) return;
                afterOpen.current = null;
                waiting.run(event.nativeEvent.layout.y);
              }}
            >
              <Card style={styles.stepCard} {...(flagged ? { rail: 'crit' as const } : {})}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isOpen }}
                  onPress={() => setOpen(isOpen ? -1 : index)}
                  style={({ pressed }) => [styles.stepHead, pressed && styles.stepHeadPressed]}
                >
                  <Text style={styles.stepNo}>{String(index + 1).padStart(2, '0')}</Text>
                  <Text style={styles.stepTitle}>{t.step[step]}</Text>
                  <Text
                    style={[
                      styles.stepState,
                      state === 'required' && styles.stepRequired,
                      flagged && styles.stepMissing,
                      state === 'done' && styles.stepDone,
                    ]}
                  >
                    {state === 'done' ? t.done : state === 'required' ? t.required : t.optional}
                  </Text>
                </Pressable>
                {isOpen ? (
                  // Fades in as it opens (M2): no height animation, which fights the keyboard.
                  <Animated.View entering={fadeIn} style={styles.stepBody}>
                    {body(step)}
                    {index < KAIZEN_STEPS.length - 1 ? (
                      <Button
                        title={t.next}
                        icon="arrow-downward"
                        variant="secondary"
                        onPress={() => {
                          // Scroll once the next step has opened and laid out: its header to the top.
                          afterOpen.current = {
                            index: index + 1,
                            run: (y) => scroller.current?.scrollTo({ y: Math.max(0, y - theme.space.sm), animated: true }),
                          };
                          setOpen(index + 1);
                        }}
                      />
                    ) : null}
                  </Animated.View>
                ) : null}
              </Card>
            </View>
          );
        })}

        {/* Destructive, so after every step and well apart from Submit, and it asks first (plan 2.3). */}
        {current?.status === 'DRAFT' ? (
          <View style={styles.discard}>
            <ConfirmAction
              title={t.deleteDraft}
              icon="delete"
              question={t.deleteDraftQuestion}
              confirmLabel={t.deleteDraft}
              keepLabel={t.keep}
              busy={discard.isPending}
              onConfirm={() => {
                haptic.destroyed();
                discard.mutate();
              }}
            />
          </View>
        ) : null}
        {/* Drizzle's message is only the query; the database's own error is its `cause`. */}
        <ErrorBanner message={error ? (error.cause ? String(error.cause) : error.message) : null} />
        <View style={styles.submit}>
          <Button testID="kaizen-submit" quiet title={submitTitle} icon="send" busy={submit.isPending} onPress={() => submit.mutate()} />
        </View>
      </ScrollView>
      <KaizenPhotoViewer
        photos={{ BEFORE: photoUri(current?.before), AFTER: photoUri(current?.after) }}
        kind={viewing}
        onClose={() => setViewing(null)}
      />
      {editing ? (
        <KaizenPhotoEditor
          source={editing.source}
          onCancel={() => {
            if (editing.fresh) void discardProcessedPhoto(editing.fresh.uri);
            setEditing(null);
          }}
          onDone={(edited) => {
            if (edited && editing.fresh) void discardProcessedPhoto(editing.fresh.uri);
            const image = edited ?? editing.fresh;
            if (image) photo.mutate({ kind: editing.kind, image, live: editing.live });
            setEditing(null);
          }}
        />
      ) : null}
    </View>
  );
}

/** For the viewer: the file, `undefined` while only the server has it, `null` for none. */
function photoUri(photo: LocalKaizen['before'] | undefined): string | null | undefined {
  return photo ? (photo.localFileUri ?? undefined) : null;
}

const useStyles = createThemedStyles((theme) => ({
  column: { flex: 1 },
  content: { paddingBottom: theme.space.xl, gap: theme.space.sm },
  stepCard: { paddingVertical: 0 },
  stepHead: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: theme.space.sm },
  // Colour only: headers are tapped tens of times a Kaizen, so the press is barely there (S5).
  stepHeadPressed: { backgroundColor: theme.color.chip },
  stepNo: { width: 24, fontFamily: theme.family.regular, fontSize: 12.5, color: theme.color.ink2 },
  stepTitle: {
    flex: 1,
    fontFamily: theme.family.bold,
    fontSize: theme.font.base,
    color: theme.color.ink,
  },
  stepState: { fontFamily: theme.family.semibold, fontSize: theme.font.label, color: theme.color.muted },
  // Required reads as more than Optional before anything is tried (#8).
  stepRequired: { color: theme.color.ink },
  // After a refused Submit: the crit rail on the card is the shape, this the word (LEDGER.md rule 3).
  stepMissing: { color: theme.color.needsSupport, fontFamily: theme.family.bold },
  // Ink, not green: green is Approved and nothing else in Kaizen (owner, 2026-10-07).
  stepDone: { color: theme.color.ink },
  stepBody: { paddingBottom: theme.space.md, gap: theme.space.sm },
  photoStep: { gap: theme.space.sm },
  photo: { borderRadius: theme.radius.control, width: '100%', aspectRatio: 4 / 3, borderWidth: 1, borderColor: theme.color.rule, backgroundColor: theme.color.chip },
  placeholder: {
    borderRadius: theme.radius.control,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.rule,
    backgroundColor: theme.color.chip,
  },
  photoHint: { fontFamily: theme.family.regular, fontSize: 12.5, lineHeight: 18, color: theme.color.ink2 },
  missingNote: { fontFamily: theme.family.semibold, fontSize: 12.5, lineHeight: 18, color: theme.color.needsSupport },
  buttons: { flexDirection: 'row', gap: theme.space.sm },
  flex: { flex: 1 },
  discard: { marginTop: theme.space.lg },
  submit: { marginTop: theme.space.lg },
  progressStrip: { gap: 6, paddingBottom: theme.space.sm, marginBottom: theme.space.sm, borderBottomWidth: 1, borderBottomColor: theme.color.rule },
  progressText: { fontFamily: theme.family.semibold, fontSize: theme.font.sm, lineHeight: 18, color: theme.color.ink },
  meter: { height: 4, backgroundColor: theme.color.ruleSoft, overflow: 'hidden' },
  // scaleX from the left edge, never width (plans/001-meter-scalex.md).
  meterFill: { height: 4, width: '100%', backgroundColor: theme.color.ink, transformOrigin: 'left' },
}));
