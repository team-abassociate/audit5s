import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Button, Muted } from './ui';
import { processCapturedPhoto, type ProcessedImage } from '../lib/capture/media';
import { theme } from '../lib/theme';

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
  onCaptured: (image: ProcessedImage) => void | Promise<void>;
  onCancel: () => void;
}

export function CameraCapture({ facing = 'back', prompt, onCaptured, onCancel }: CameraCaptureProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const camera = useRef<CameraView>(null);

  if (!permission) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.prompt}>The camera is needed to record evidence</Text>
        <Muted>
          Photographs are the record of what was found. Without the camera an audit cannot be
          completed.
        </Muted>
        <Button title="Allow the camera" onPress={() => void requestPermission()} />
        <Button title="Back" variant="secondary" onPress={onCancel} />
      </View>
    );
  }

  const take = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const photo = await camera.current?.takePictureAsync({ skipProcessing: false });
      if (!photo?.uri) return;
      // Downscaled, EXIF-stripped and hashed before anything else sees it (§9.4).
      await onCaptured(await processCapturedPhoto(photo.uri));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <CameraView ref={camera} style={styles.preview} facing={facing} />

      <View style={styles.controls}>
        <Text style={styles.prompt}>{prompt}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take the photograph"
          onPress={() => void take()}
          style={[styles.shutter, busy && styles.shutterBusy]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <View style={styles.shutterInner} />}
        </Pressable>
        <Button title="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  preview: { flex: 1 },
  controls: { padding: 20, gap: 14, alignItems: 'center', backgroundColor: '#000' },
  prompt: { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.6 },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
});
