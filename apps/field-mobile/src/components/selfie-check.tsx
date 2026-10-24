import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { retakeLocalSelfie, selfieStatuses, type SelfieStatus } from '../lib/db/evidence.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { CameraCapture } from './camera-capture';
import { ActionSheet, Chip, Muted, Slip, SlipText } from './ui';

/**
 * The selfie, confirmed without ever blocking the auditor (owner, 2026-10-24).
 *
 * §7.1 starts an audit on the server only once its selfie arrives, and the phone works
 * offline, so the selfie cannot be a gate at step 1. Instead it is watched: a chip while it
 * is on its way, a retake when it failed for good, and a choice at Submit — submit now and
 * let it upload later, or take it again — so nobody finishes an audit that can never finish.
 */

/** Every audit's selfie status on this phone, for the list cards. */
export function useSelfieStatuses() {
  const database = useLocalDatabase();
  return useQuery({
    queryKey: ['local', 'selfie-statuses'],
    queryFn: () => selfieStatuses(database),
  });
}

/** The card's chip: nothing once the selfie is on the server. */
export function SelfieChip({ status }: { status: SelfieStatus | undefined }) {
  if (status === 'PENDING') return <Chip tone="warn">Selfie not uploaded yet</Chip>;
  if (status === 'FAILED') return <Chip tone="crit">Selfie failed — retake</Chip>;
  return null;
}

/**
 * One audit's selfie: its status, the Submit check, the retake camera and the notice.
 *
 * A screen renders `camera` in place of itself while it is open (the camera is full-screen,
 * as everywhere else), `sheet` anywhere, and `notice` where the auditor will see it.
 */
export function useSelfieCheck(auditId: string | undefined) {
  const queryClient = useQueryClient();
  const database = useLocalDatabase();
  const statuses = useSelfieStatuses();
  const status = auditId ? statuses.data?.get(auditId) : undefined;

  // The Submit waiting on the auditor's choice; the sheet is open while it is set.
  const [ask, setAsk] = useState<(() => void) | null>(null);
  // What to do once a retake is saved: the Submit it interrupted, or nothing.
  const [afterRetake, setAfterRetake] = useState<(() => void) | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Back over the camera closes it. Registered after the screen's own handler, so it runs first.
  useEffect(() => {
    if (!cameraOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setCameraOpen(false);
      setAfterRetake(null);
      return true;
    });
    return () => subscription.remove();
  }, [cameraOpen]);

  const retake = useMutation({
    mutationFn: (image: Parameters<typeof retakeLocalSelfie>[2]) =>
      retakeLocalSelfie(database, auditId!, image),
    onSuccess: async () => {
      setCameraOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      afterRetake?.();
      setAfterRetake(null);
    },
  });

  /** Runs `proceed` at once if the selfie is on the server; otherwise asks first. */
  const gate = (proceed: () => void) => {
    if (status === 'PENDING' || status === 'FAILED') setAsk(() => proceed);
    else proceed();
  };

  const openRetake = (then: (() => void) | null = null) => {
    setAfterRetake(() => then);
    setCameraOpen(true);
  };

  const takeAgain = { label: 'Take my selfie again', detail: 'Your answers stay as they are.', onPress: () => openRetake(ask) };
  const submitAnyway =
    status === 'FAILED'
      ? {
          label: 'Submit without it',
          detail: 'The audit cannot finish on the server until a selfie reaches it.',
          onPress: () => ask?.(),
        }
      : { label: 'Submit now', detail: 'The selfie uploads with the audit when there is signal.', onPress: () => ask?.() };

  const sheet = (
    <ActionSheet
      visible={ask !== null && !cameraOpen}
      title={
        status === 'FAILED'
          ? 'Your selfie could not be uploaded'
          : 'Your selfie has not reached the server yet'
      }
      onClose={() => setAsk(null)}
      // A failed selfie leads with the retake; one merely on its way, with Submit.
      actions={status === 'FAILED' ? [takeAgain, submitAnyway] : [submitAnyway, takeAgain]}
    />
  );

  const camera = cameraOpen ? (
    <CameraCapture
      facing="front"
      prompt="Retake your selfie"
      onCaptured={async (image) => {
        await retake.mutateAsync({
          localFileUri: image.uri,
          byteSize: image.byteSize,
          width: image.width,
          height: image.height,
          checksumSha256: image.checksumSha256,
        });
      }}
      onCancel={() => {
        setCameraOpen(false);
        setAfterRetake(null);
      }}
    />
  ) : null;

  const notice =
    status === 'FAILED' ? (
      <Slip accessibilityRole="button" title="Your selfie could not be uploaded" onPress={() => openRetake()}>
        <SlipText>The audit cannot finish on the server without it. Tap to retake it; your answers stay as they are.</SlipText>
      </Slip>
    ) : status === 'PENDING' ? (
      <Muted>Selfie not uploaded yet. It goes to the server with the next sync.</Muted>
    ) : null;

  return { status, gate, sheet, camera, notice };
}
