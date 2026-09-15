import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deleteLocalEvidence,
  setLocalSummaryFlag,
  type listLocalEvidenceForZone,
} from '../lib/db/evidence.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { createThemedStyles, type Band } from '../lib/theme';
import { Button, Card, CardHeader, Chip, ConfirmAction, ErrorBanner, Label, Muted } from './ui';

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

function classificationTone(value: string): Band | 'muted' {
  return value === 'GOOD' ? 'ok' : value === 'NONCONFORMITY' ? 'crit' : 'muted';
}

/** A row of tappable thumbnails. Status is written, not only coloured (GEMBA-BOARD.md). */
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
}: {
  photos: readonly LocalPhoto[];
  onOpen: (evidenceId: string) => void;
}) {
  const styles = useStyles();
  const good = photos.find((photo) => photo.isSummaryFlagged === 1 && photo.classification === 'GOOD');
  const bad = photos.find(
    (photo) => photo.isSummaryFlagged === 1 && photo.classification === 'NONCONFORMITY',
  );

  const slot = (title: string, photo: LocalPhoto | undefined) => (
    <View style={styles.slot}>
      <Label>{title}</Label>
      {photo ? (
        <PhotoThumbs photos={[photo]} onOpen={onOpen} />
      ) : (
        <View style={styles.slotEmpty}>
          <Text style={styles.thumbMissingText}>Not chosen</Text>
        </View>
      )}
    </View>
  );

  return (
    <Card>
      <CardHeader
        title="Summary photos"
        description="Open a photograph to flag one Good and one Nonconformity. They represent this Zone in the unit summary report."
      />
      <View style={styles.slots}>
        {slot('Good', good)}
        {slot('Nonconformity', bad)}
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

/** Full-screen preview with the two decisions: flag for the summary, or delete. */
export function PhotoPreview({
  photo,
  editable,
  onClose,
}: {
  photo: LocalPhoto | null;
  editable: boolean;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const label = classificationLabel(photo?.classification ?? 'NEUTRAL');

  const flag = useMutation({
    mutationFn: (flagged: boolean) => setLocalSummaryFlag(database, photo!.id, flagged),
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

  const remove = useMutation({
    mutationFn: () => deleteLocalEvidence(database, photo!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setError(null);
      onClose();
    },
  });

  if (!photo) return null;

  const flagged = photo.isSummaryFlagged === 1;
  const flaggable = photo.classification === 'GOOD' || photo.classification === 'NONCONFORMITY';
  const close = () => {
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
            <Image
              source={{ uri: photo.localFileUri }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityLabel={`${label} photograph`}
            />
          ) : (
            <View style={styles.thumbMissing}>
              <Text style={styles.thumbMissingText}>The file is no longer stored on this device</Text>
            </View>
          )}

          <View style={styles.tags}>
            <Chip tone={classificationTone(photo.classification)}>{label}</Chip>
            {flagged ? <Chip>Summary photo</Chip> : null}
          </View>

          {editable ? (
            <View style={styles.actions}>
              {flaggable ? (
                <Button
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
        <Button title="Close" variant="secondary" onPress={close} />
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles((theme) => ({
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.sm },
  thumb: { width: 88, borderWidth: 1.5, borderColor: theme.color.edge, backgroundColor: theme.color.tile },
  thumbImage: { width: '100%', aspectRatio: 1, backgroundColor: theme.color.tile2 },
  thumbMissing: {
    minHeight: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.tile2,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    padding: theme.space.xs,
  },
  thumbMissingText: { fontFamily: theme.family.regular, fontSize: 11.5, color: theme.color.ink2, textAlign: 'center' },
  thumbLabel: {
    fontFamily: theme.family.medium,
    fontSize: 11,
    color: theme.color.ink,
    paddingHorizontal: 4,
    paddingVertical: 3,
  },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  slots: { flexDirection: 'row', gap: theme.space.md, marginBottom: theme.space.md },
  slot: { flex: 1 },
  slotEmpty: {
    width: 88,
    minHeight: 104,
    marginTop: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  preview: { flex: 1, backgroundColor: theme.color.tile, paddingHorizontal: theme.space.md, gap: theme.space.sm },
  previewContent: { gap: theme.space.sm, paddingBottom: theme.space.md },
  previewTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
  },
  previewImage: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: theme.color.tile2,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  actions: { gap: theme.space.sm },
}));
