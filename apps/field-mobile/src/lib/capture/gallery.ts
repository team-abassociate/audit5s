import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator } from 'expo-image-manipulator';
import { processCapturedPhoto, type ProcessedImage } from './media';

/**
 * A photograph from the phone's gallery: a corrective action's after-photo (R-38; widened to
 * nonconformities by the owner, 2026-10-13), an auditor's photographs in an audit, scored and
 * walk-by (the owner, 2026-10-13, overriding §12.10), and **Kaizen's before and after** (R-48:
 * a "before" is often already on the phone, taken before anyone thought of a Kaizen).
 *
 * The one exception is the attendance selfie, which stays a live capture through
 * `CameraCapture` — the server refuses a selfie that is not.
 *
 * This file is the only importer of `expo-image-picker`, so a grep for it finds the whole
 * of the gallery path. It opens Android's system photo picker, which needs no permission: the
 * app receives the one photograph the person chose and never reads the library itself.
 *
 * The chosen file goes through `processCapturedPhoto` exactly as a camera frame does —
 * ≤1920 px, JPEG, EXIF (GPS included) gone, hashed after re-encoding — so it uploads, commits
 * and prints like any other. It is recorded as **not** a live capture, which the server
 * accepts everywhere but the selfie.
 *
 * Null when the person closes the picker without choosing.
 */
export async function pickFromGallery(): Promise<ProcessedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    allowsMultipleSelection: false,
    // The original: the re-encode below is the one compression step, as for the camera.
    quality: 1,
    exif: false,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;

  // Measured by the manipulator that will resize it, not taken from the picker: for an
  // image the picker reports the stored size, before EXIF rotation, so a portrait photo
  // could read as landscape and be resized on the wrong edge — over §9.4's 1920 px.
  const decoded = await ImageManipulator.manipulate(asset.uri).renderAsync();
  const size = { width: decoded.width, height: decoded.height };
  decoded.release();
  return processCapturedPhoto(asset.uri, size);
}
