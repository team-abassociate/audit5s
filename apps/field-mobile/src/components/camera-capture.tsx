import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Button } from './ui';
import { warmLocation } from '../lib/capture/location';
import { MAX_LONG_EDGE_PX, processCapturedPhoto, type ProcessedImage } from '../lib/capture/media';
import { ZONE_PHOTO_LIMIT_MESSAGE } from '../lib/db/photo-limit';
import { gemba, gembaFonts } from '../lib/gemba';

/**
 * The live-capture camera (§12.10).
 *
 * > Custom camera view (`expo-camera`); **no gallery picker is present in the
 * > corrective-action or walk-by flows**; `is_live_capture=true` set by the capture
 * > component only.
 *
 * That absence is the control, such as it is: there is no code path in this component that
 * could produce an image the auditor did not just take, so `isLiveCapture` is not a flag a
 * caller passes but a fact about where the bytes came from.
 *
 * §12.10 is equally clear about the limit, and the UI is written to match rather than to
 * overstate: "A modified build or a rooted device could inject frames. Detected only
 * probabilistically." The screen says a photo was taken now; it never says it proves
 * anything. The design position is deterrence plus evidence, not prevention.
 *
 * `expo-camera` is the settled choice (R-11), superseding `STACK.md` §2's stale
 * react-native-vision-camera row. This file is the only importer of it in the workspace:
 * everything downstream — the capture contract, the object key, `isLiveCapture`, E-1 — is
 * library-agnostic, so the choice stays reversible at the cost of one component.
 */
export interface CameraCaptureProps {
  facing?: CameraType;
  /** Shown above the shutter — "Take your selfie", "Photograph the nonconformity". */
  prompt: string;
  beforeCapture?: () => Promise<void>;
  onCaptured: (image: ProcessedImage) => void | Promise<void>;
  onCancel: () => void;
}

export function CameraCapture({ facing = 'back', prompt, onCaptured, onCancel, beforeCapture }: CameraCaptureProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taking = useRef(false);
  const camera = useRef<CameraView>(null);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);

  // The location fix starts while the auditor frames the shot, so the shutter never waits
  // for satellites (§12.9: a missing fix is recorded, never a reason to stall).
  useEffect(() => {
    warmLocation();
  }, []);

  // The smallest frame the sensor offers that still covers §9.4's 1920 px long edge. The
  // default is the full sensor — 12 MP and up — which is several times more to encode,
  // write, decode and shrink than anything that is kept.
  const choosePictureSize = async () => {
    try {
      const sizes = (await camera.current?.getAvailablePictureSizesAsync()) ?? [];
      const parsed = sizes
        .map((size) => {
          const [w = 0, h = 0] = size.split('x').map(Number);
          return { size, w, h };
        })
        .filter((entry) => entry.w > 0 && entry.h > 0);
      if (parsed.length === 0) return;
      const largest = parsed.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      // Same shape as the full sensor, so the preview and the photograph frame alike.
      const ratio = largest.w / largest.h;
      const fit = parsed
        .filter((entry) => Math.abs(entry.w / entry.h - ratio) < 0.02)
        .filter((entry) => Math.max(entry.w, entry.h) >= MAX_LONG_EDGE_PX)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (fit) setPictureSize(fit.size);
    } catch {
      // The default size still works; it is only slower.
    }
  };

  if (!permission) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={gemba.dark.ink} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.prompt}>The camera is needed to record evidence</Text>
        <Text style={styles.detail}>
          Photographs are the record of what was found. Without the camera an audit cannot be
          completed.
        </Text>
        <Button title="Allow the camera" onPress={() => void requestPermission()} />
        <Button title="Back" variant="secondary" onPress={onCancel} />
      </View>
    );
  }

  const take = async () => {
    if (taking.current) return;
    taking.current = true;
    setBusy(true);
    setError(null);
    try {
      await beforeCapture?.();
      // q0.9 from the sensor: it is re-encoded at q0.8 below, so the extra is never kept.
      const photo = await camera.current?.takePictureAsync({ quality: 0.9, skipProcessing: false });
      if (!photo?.uri) return;
      // Downscaled, EXIF-stripped and hashed before anything else sees it (§9.4).
      await onCaptured(
        await processCapturedPhoto(photo.uri, { width: photo.width, height: photo.height }),
      );
    } catch (cause) {
      // Said on the screen the auditor is looking at, never an unhandled rejection: nothing
      // was saved, so the honest words are "try again".
      console.error('capture failed', cause);
      setError(cause instanceof Error && cause.message.includes(ZONE_PHOTO_LIMIT_MESSAGE)
        ? ZONE_PHOTO_LIMIT_MESSAGE : 'The photograph was not saved. Try again.');
    } finally {
      taking.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <CameraView
        ref={camera}
        style={styles.preview}
        facing={facing}
        pictureSize={pictureSize}
        onCameraReady={() => void choosePictureSize()}
      />

      <View style={styles.controls}>
        <Text style={styles.prompt}>{prompt}</Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take the photograph"
          onPress={() => void take()}
          style={[styles.shutter, busy && styles.shutterBusy]}
        >
          {busy ? <ActivityIndicator color={gemba.dark.ink} /> : <View style={styles.shutterInner} />}
        </Pressable>
        <Button title="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: gemba.dark.board },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: gemba.dark.board },
  preview: { flex: 1 },
  controls: { padding: 20, gap: 14, alignItems: 'center', backgroundColor: gemba.dark.board },
  prompt: { color: gemba.dark.ink, fontFamily: gembaFonts.medium, fontSize: 16, textAlign: 'center' },
  detail: { color: gemba.dark.ink2, fontFamily: gembaFonts.regular, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderWidth: 4,
    borderColor: gemba.dark.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.6 },
  error: { color: gemba.dark.crit, fontFamily: gembaFonts.medium, fontSize: 13, textAlign: 'center' },
  shutterInner: { width: 58, height: 58, backgroundColor: gemba.dark.ink },
});
