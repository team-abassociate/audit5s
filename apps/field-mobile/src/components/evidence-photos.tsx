import { useEffect, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteLocalEvidence,
  getLocalAuditeePhoto,
  pickLocalSummaryPhoto,
  setLocalEvidenceRemark,
  setLocalSummaryFlag,
  type listLocalEvidenceForZone,
} from '../lib/db/evidence.repository';
import { applyLocalPhotoOverride } from '../lib/db/audit.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { createThemedStyles, type Tone } from '../lib/theme';
import { PhotoZoomViewer } from './kaizen-photo-viewer';
import { Button, Card, CardHeader, Chip, ConfirmAction, ErrorBanner, Field, Label, Muted, SelectField } from './ui';

/**
 * The photographs of a scored Zone: thumbnails, a full-size preview, delete (E-4) and the
 * summary flag (§5.6).
 *
 * §2.3 steps 12 and 13 give the auditor two decisions about a photograph after taking it —
 * whether to keep it at all, and whether it is one of the two that represent the Zone in the
 * summary. Both are made while looking at the picture, which is why they live in the preview
 * rather than on a list row.
 */

export type LocalPhoto = Awaited<ReturnType<typeof listLocalEvidenceForZone>>[number];

export function classificationLabel(value: string): string {
  return value === 'NONCONFORMITY' ? 'Nonconformity' : value === 'GOOD' ? 'Good' : 'Neutral';
}

function classificationTone(value: string): Tone | 'muted' {
  return value === 'GOOD' ? 'ok' : value === 'NONCONFORMITY' ? 'crit' : 'muted';
}

/** A row of tappable thumbnails. Status is written, not only coloured (LEDGER.md rule 3). */
export function PhotoThumbs({
  photos,
  onOpen,
}: {
  photos: readonly LocalPhoto[];
  onOpen: (evidenceId: string) => void;
}) {
  const styles = useStyles();
  if (photos.length === 0) return null;

  return (
    <View style={styles.thumbs}>
      {photos.map((photo) => {
        const label = classificationLabel(photo.classification);
        const flagged = photo.isSummaryFlagged === 1;
        return (
          <Pressable
            key={photo.id}
            accessibilityRole="button"
            accessibilityLabel={`Preview ${label} photograph${flagged ? ', summary photo' : ''}`}
            onPress={() => onOpen(photo.id)}
            style={({ pressed }) => [styles.thumb, pressed && styles.pressed]}
          >
            {photo.localFileUri ? (
              <Image source={{ uri: photo.localFileUri }} style={styles.thumbImage} resizeMode="cover" />
            ) : (
              <View style={styles.thumbMissing}>
                <Text style={styles.thumbMissingText}>No preview</Text>
              </View>
            )}
            <Text style={styles.thumbLabel} numberOfLines={1}>
              {flagged ? 'Summary · ' : ''}
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The Zone's two summary slots — one Good, one Nonconformity — and every photograph taken in
 * it, so the choice can be made in one place before the Zone is submitted.
 */
export function SummaryPhotosCard({
  photos,
  onOpen,
  onAdd,
}: {
  photos: readonly LocalPhoto[];
  onOpen: (evidenceId: string) => void;
  /** R-91: opens a slot's sheet. Absent when the audit is not open, so nothing is offered. */
  onAdd?: (slot: SummarySlot) => void;
}) {
  const styles = useStyles();
  const good = photos.find((photo) => photo.isSummaryFlagged === 1 && photo.classification === 'GOOD');
  const bad = photos.find(
    (photo) => photo.isSummaryFlagged === 1 && photo.classification === 'NONCONFORMITY',
  );

  const slot = (title: string, kind: SummarySlot, photo: LocalPhoto | undefined) => (
    <View style={styles.slot}>
      <Label>{title}</Label>
      {photo ? (
        <PhotoThumbs photos={[photo]} onOpen={onOpen} />
      ) : onAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add the ${title} summary photo`}
          onPress={() => onAdd(kind)}
          style={({ pressed }) => [styles.slotEmpty, pressed && styles.pressed]}
        >
          <Text style={styles.thumbMissingText}>Not chosen{'\n'}Tap to add</Text>
        </Pressable>
      ) : (
        <View style={styles.slotEmpty}>
          <Text style={styles.thumbMissingText}>Not chosen</Text>
        </View>
      )}
      {onAdd ? (
        <View style={styles.slotAction}>
          <Button
            compact
            icon={photo ? 'swap-horiz' : 'add-a-photo'}
            title={photo ? 'Change' : 'Add'}
            variant="secondary"
            accessibilityLabel={`${photo ? 'Change' : 'Add'} the ${title} summary photo`}
            onPress={() => onAdd(kind)}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <Card>
      <CardHeader
        title="Summary photos"
        description={
          onAdd
            ? 'One Good and one Nonconformity represent this Zone in the reports. Add an individual photo with a remark, or a photo for a question.'
            : 'Open a photograph to flag one Good and one Nonconformity. They represent this Zone in the unit summary report.'
        }
      />
      <View style={styles.slots}>
        {slot('Good', 'GOOD', good)}
        {slot('Nonconformity', 'NONCONFORMITY', bad)}
      </View>
      {photos.length > 0 ? (
        <>
          <Label>All photographs in this Zone</Label>
          <PhotoThumbs photos={photos} onOpen={onOpen} />
        </>
      ) : (
        <Muted>No photographs yet. Take one from any question.</Muted>
      )}
    </Card>
  );
}

export type SummarySlot = 'GOOD' | 'NONCONFORMITY';
export type PhotoSource = 'camera' | 'gallery';

/** A question the slot may draw on: marked 2 for Good, 1 or 0 for Nonconformity (E-1). */
export interface SummaryQuestion {
  questionId: string;
  label: string;
  photos: readonly LocalPhoto[];
}

/**
 * R-91: a summary slot's two ways in, from the end of the audit, so the auditor never has to
 * page back through the questions.
 *
 * 1. **An individual photo**: camera or gallery, linked to no question, with the remark
 *    typed here first (owner, 2026-11-25).
 * 2. **From a question**: the questions marked to fit the slot. Use one of a question's
 *    photographs, or add one to that question, which then becomes the summary photo.
 *
 * Either replaces the photo now in the slot.
 */
export function SummaryPhotoSheet({
  slot,
  questions,
  canAddToQuestion,
  busy,
  error,
  onOwnPhoto,
  onQuestionPhoto,
  onPick,
  onClose,
}: {
  slot: SummarySlot | null;
  questions: readonly SummaryQuestion[];
  /** False once the Zone holds 25 question photographs; a photo of its own is not counted. */
  canAddToQuestion: boolean;
  busy: boolean;
  error: string | null;
  onOwnPhoto: (source: PhotoSource, remark: string | null) => void;
  onQuestionPhoto: (questionId: string, source: PhotoSource) => void;
  onPick: (evidenceId: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [remark, setRemark] = useState('');

  useEffect(() => {
    setQuestionId(null);
    setRemark('');
  }, [slot]);
  const ownRemark = remark.trim() || null;

  if (!slot) return null;
  const title = slot === 'GOOD' ? 'Good' : 'Nonconformity';
  const marks = slot === 'GOOD' ? 'marked 2' : 'marked 1 or 0';
  const chosen = questions.find((question) => question.questionId === questionId) ?? null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.preview, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <ScrollView contentContainerStyle={styles.previewContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.previewTitle} accessibilityRole="header">
            {title} summary photo
          </Text>
          <Muted>It represents this Zone in the Zone report and the summary report, and replaces the one there now.</Muted>

          <Card>
            <CardHeader
              title="Individual photo"
              description="Not linked to any question. Write its remark, then take or choose the photo."
            />
            <Field
              label="Remark"
              multiline
              placeholder="What this photograph shows"
              value={remark}
              onChangeText={setRemark}
              maxLength={2000}
            />
            <View style={styles.sourceRow}>
              <View style={styles.sourceButton}>
                <Button icon="photo-camera" title="Take photo" variant="secondary" disabled={busy} onPress={() => onOwnPhoto('camera', ownRemark)} />
              </View>
              <View style={styles.sourceButton}>
                <Button icon="photo-library" title="From gallery" variant="secondary" disabled={busy} onPress={() => onOwnPhoto('gallery', ownRemark)} />
              </View>
            </View>
          </Card>

          <Card>
            <CardHeader
              title="From a question"
              description={`Questions ${marks}. Use one of its photographs, or add one to it.`}
            />
            {questions.length === 0 ? (
              <Muted>No question is {marks} yet.</Muted>
            ) : (
              <SelectField
                label={`Question ${marks}`}
                placeholder="Choose a question…"
                searchable={questions.length > 8}
                options={questions.map((question) => ({
                  value: question.questionId,
                  label: question.label,
                  detail: question.photos.length === 1 ? '1 photograph' : `${question.photos.length} photographs`,
                }))}
                value={questionId}
                onChange={setQuestionId}
              />
            )}
            {chosen ? (
              <>
                {chosen.photos.length > 0 ? (
                  <>
                    <Label>Tap a photograph to use it</Label>
                    <PhotoThumbs photos={chosen.photos} onOpen={onPick} />
                  </>
                ) : (
                  <Muted>No photographs on this question yet.</Muted>
                )}
                {canAddToQuestion ? (
                  <View style={styles.sourceRow}>
                    <View style={styles.sourceButton}>
                      <Button
                        icon="photo-camera"
                        title="Take photo"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => onQuestionPhoto(chosen.questionId, 'camera')}
                      />
                    </View>
                    <View style={styles.sourceButton}>
                      <Button
                        icon="photo-library"
                        title="From gallery"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => onQuestionPhoto(chosen.questionId, 'gallery')}
                      />
                    </View>
                  </View>
                ) : (
                  <Muted>This Zone has its 25 question photographs. Add an individual photo instead.</Muted>
                )}
              </>
            ) : null}
          </Card>

          <ErrorBanner message={error} />
        </ScrollView>
        <Button icon="close" title="Cancel" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

/** R-72: who faced the audit of this Zone, and their photo — the proof management asked for. */
export function AuditeeCard({ auditZoneId, name, title }: { auditZoneId: string; name: string | null; title: string }) {
  const styles = useStyles();
  const database = useLocalDatabase();
  const photo = useQuery({
    queryKey: ['local', 'auditee-photo', auditZoneId],
    queryFn: () => getLocalAuditeePhoto(database, auditZoneId),
  });
  const uri = photo.data?.localFileUri;
  // A Zone started before R-72 has neither, and nothing to show.
  if (!name && !photo.data) return null;
  return (
    <Card>
      <CardHeader title={title} description={name} />
      {uri ? <Image source={{ uri }} style={styles.auditeePhoto} resizeMode="cover" accessibilityLabel={name ?? title} /> : null}
    </Card>
  );
}

/**
 * Full-screen preview with the two decisions — flag for the summary, or delete — and the
 * photograph's own remark, which the reports print under it. The remark saves on Continue.
 */
export function PhotoPreview({
  photo,
  editable,
  correction = null,
  onClose,
}: {
  photo: LocalPhoto | null;
  editable: boolean;
  /**
   * R-81: reviewing a finished audit. Delete and the summary pick then ride the logged
   * correction (A-2), with this reason; the photo's remark is not changed here.
   */
  correction?: { auditId: string; justification: string } | null;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [zoomed, setZoomed] = useState(false);

  // Each photograph opens on its own saved remark.
  useEffect(() => {
    setRemark(photo?.remark ?? '');
    setZoomed(false);
  }, [photo?.id]);

  const label = classificationLabel(photo?.classification ?? 'NEUTRAL');

  const flag = useMutation({
    mutationFn: async (flagged: boolean) => {
      // R-91: picking replaces the slot's photo rather than refusing while it is taken.
      if (!correction) {
        return flagged
          ? pickLocalSummaryPhoto(database, photo!.id)
          : setLocalSummaryFlag(database, photo!.id, false);
      }
      if (flagged && photo!.classification !== 'GOOD' && photo!.classification !== 'NONCONFORMITY') {
        return { ok: false as const, reason: 'NEUTRAL' as const };
      }
      await applyLocalPhotoOverride(database, { ...correction, evidenceId: photo!.id, isSummaryFlagged: flagged });
      return { ok: true as const };
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(
          result.reason === 'NEUTRAL'
            ? 'Only a Good or a Nonconformity photograph can be a summary photo.'
            : `This Zone already has a ${label} summary photo. Open that one and remove its flag first.`,
        );
        return;
      }
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  const saveRemark = useMutation({
    mutationFn: (next: string | null) => setLocalEvidenceRemark(database, photo!.id, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  const remove = useMutation({
    mutationFn: () =>
      correction && photo!.objectKey
        ? applyLocalPhotoOverride(database, { ...correction, evidenceId: photo!.id, deleted: true })
        : deleteLocalEvidence(database, photo!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setError(null);
      onClose();
    },
  });

  if (!photo) return null;

  const flagged = photo.isSummaryFlagged === 1;
  /** R-91: added for the summary and linked to no question; deleting it is how it goes. */
  const summaryOnly = photo.kind === 'SUMMARY_PHOTO';
  const flaggable = photo.classification === 'GOOD' || photo.classification === 'NONCONFORMITY';
  const close = () => {
    const next = remark.trim() || null;
    if (editable && !correction && next !== (photo.remark ?? null)) saveRemark.mutate(next);
    setError(null);
    onClose();
  };

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={[styles.preview, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <ScrollView contentContainerStyle={styles.previewContent}>
          <Text style={styles.previewTitle} accessibilityRole="header">
            Photograph
          </Text>
          {photo.localFileUri ? (
            <Pressable
              onPress={() => setZoomed(true)}
              accessibilityRole="imagebutton"
              accessibilityHint="Opens the photograph full screen to zoom"
            >
              <Image
                source={{ uri: photo.localFileUri }}
                style={styles.previewImage}
                resizeMode="contain"
                accessibilityLabel={`${label} photograph`}
              />
              <Muted>Tap the photo to zoom in.</Muted>
            </Pressable>
          ) : (
            <View style={styles.thumbMissing}>
              <Text style={styles.thumbMissingText}>The file is no longer stored on this device</Text>
            </View>
          )}

          <View style={styles.tags}>
            <Chip tone={classificationTone(photo.classification)}>{label}</Chip>
            {flagged ? <Chip>Summary photo</Chip> : null}
            {summaryOnly ? <Chip>No question</Chip> : null}
          </View>

          {editable && !correction ? (
            <Field
              label="Remark"
              multiline
              placeholder="What this photograph shows"
              value={remark}
              onChangeText={setRemark}
              maxLength={2000}
            />
          ) : photo.remark ? (
            <Muted>{photo.remark}</Muted>
          ) : null}

          {editable ? (
            <View style={styles.actions}>
              {summaryOnly ? (
                <Muted>Added for the summary and linked to no question. Delete it to take it out.</Muted>
              ) : flaggable ? (
                <Button icon={flagged ? 'outlined-flag' : 'flag'}
                  title={flagged ? 'Remove summary flag' : `Use as the ${label} summary photo`}
                  variant="secondary"
                  busy={flag.isPending}
                  onPress={() => flag.mutate(!flagged)}
                />
              ) : (
                <Muted>
                  This photograph is Neutral, so it cannot be a summary photo. It becomes Good or
                  Nonconformity from the answer to its question.
                </Muted>
              )}
              <ConfirmAction
                title="Delete photo"
                question="Delete this photograph? If it has not been uploaded yet it never will be; if it has, it is removed from the audit."
                confirmLabel="Delete"
                busy={remove.isPending}
                onConfirm={() => remove.mutate()}
              />
            </View>
          ) : (
            <Muted>This Zone is finished, so its photographs can no longer be changed.</Muted>
          )}

          <ErrorBanner message={error} />
        </ScrollView>
        <Button icon="arrow-forward" title="Continue" variant="secondary" onPress={close} />
      </View>
      <PhotoZoomViewer
        uri={zoomed ? photo.localFileUri : null}
        label={`${label} photograph`}
        onClose={() => setZoomed(false)}
      />
    </Modal>
  );
}

const useStyles = createThemedStyles((theme) => ({
  auditeePhoto: { borderRadius: theme.radius.control, width: 120, aspectRatio: 1, borderWidth: 1, borderColor: theme.color.rule, backgroundColor: theme.color.chip },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.sm },
  thumb: { borderRadius: theme.radius.control, width: 88, borderWidth: 1, borderColor: theme.color.rule, backgroundColor: theme.color.surface },
  thumbImage: { width: '100%', aspectRatio: 1, backgroundColor: theme.color.chip },
  thumbMissing: {
    borderRadius: theme.radius.control,
    minHeight: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.chip,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.rule,
    padding: theme.space.xs,
  },
  thumbMissingText: { fontFamily: theme.family.regular, fontSize: 11.5, color: theme.color.ink2, textAlign: 'center' },
  thumbLabel: {
    fontFamily: theme.family.semibold,
    fontSize: 11,
    color: theme.color.ink,
    paddingHorizontal: 4,
    paddingVertical: 3,
  },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.88 },
  slots: { flexDirection: 'row', gap: theme.space.md, marginBottom: theme.space.md },
  slot: { flex: 1 },
  slotAction: { marginTop: theme.space.sm, alignItems: 'flex-start' },
  sourceRow: { flexDirection: 'row', gap: theme.space.sm },
  sourceButton: { flex: 1 },
  slotEmpty: {
    borderRadius: theme.radius.control,
    width: 88,
    minHeight: 104,
    marginTop: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.rule,
    backgroundColor: theme.color.chip,
  },
  preview: { flex: 1, backgroundColor: theme.color.surface, paddingHorizontal: theme.space.md, gap: theme.space.sm },
  previewContent: { gap: theme.space.sm, paddingBottom: theme.space.md },
  previewTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
  },
  previewImage: {
    borderRadius: theme.radius.control,
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: theme.color.chip,
    borderWidth: 1,
    borderColor: theme.color.rule,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  actions: { gap: theme.space.sm },
}));
