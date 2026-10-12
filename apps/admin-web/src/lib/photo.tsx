import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Photographs from a browser: the camera (`getUserMedia`), the gallery, the 1920 px JPEG
 * both are redrawn to, and the presigned PUT. Shared by the corrective-action link page,
 * the signed-in answer, Kaizen and web audits, so a photo leaves every page the same way.
 */
/**
 * The after-photo: the chosen one with *Remove photograph*, or else the camera and the
 * gallery one above the other (R-38, R-40). Removing it brings both options back.
 */
export function PhotoPicker({
  photoUrl,
  onPhoto,
  onRemove,
  hint,
}: {
  photoUrl: string | null;
  onPhoto: (blob: Blob, live: boolean) => void;
  onRemove: () => void;
  hint: string;
}) {
  if (photoUrl) {
    return (
      <div className="space-y-2">
        <img
          src={photoUrl}
          alt="The photograph you chose"
          className="w-full border border-edge-soft"
          referrerPolicy="no-referrer"
        />
        <button type="button" className="gb-btn gb-btn--block" onClick={onRemove}
        >
          Remove photograph
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <LiveCapture onCapture={(blob) => onPhoto(blob, true)} />
      <GalleryPick onPick={(blob) => onPhoto(blob, false)} />
      <p className="text-xs text-ink-2">{hint}</p>
    </div>
  );
}

/**
 * The camera (§10.4, §12.10).
 *
 * `getUserMedia` with the rear camera where there is one, drawn to a canvas and encoded as
 * JPEG. A refused or absent camera is reported plainly; the gallery beside it is the other
 * way to attach a photograph (R-40).
 */
export function LiveCapture({
  onCapture,
  facing = 'environment',
  openLabel = 'Open the camera',
}: {
  onCapture: (blob: Blob) => void;
  /** `user` for an auditor's selfie (§7.1); the rear camera for everything else. */
  facing?: 'environment' | 'user';
  openLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  // The camera light must not stay on because somebody navigated away.
  useEffect(() => stop, [stop]);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open a camera. Choose a photograph from your gallery instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      setLive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setError(
        'The camera could not be opened. Allow camera access for this page and try again, ' +
          'or choose a photograph from your gallery.',
      );
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;

    // Downscaled to a 1920 px long edge before it leaves the page, matching what the
    // mobile capture path does (STACK.md §5) — a 12 MP frame over mobile data is the
    // difference between a submission that completes and one that times out.
    void toJpeg(video, video.videoWidth, video.videoHeight).then((blob) => {
      if (blob) {
        onCapture(blob);
        stop();
      }
    });
  }

  return (
    <div className="space-y-2">
      <video
        ref={videoRef}
        playsInline
        muted
        className={live ? 'w-full border border-edge bg-ink' : 'hidden'}
      />
      {live ? (
        <button type="button" className="gb-btn gb-btn--primary gb-btn--block" onClick={capture}
        >
          Take the photograph
        </button>
      ) : (
        <button type="button" className="gb-btn gb-btn--block" onClick={start}
        >
          {openLabel}
        </button>
      )}
      {error ? <p className="gb-field-error" role="alert">{error}</p> : null}
    </div>
  );
}

/**
 * A photograph from the phone's gallery — for any corrective action (R-38, R-40).
 *
 * The chosen file is decoded and redrawn as a JPEG at a 1920 px long edge before it leaves
 * the page, like a camera frame: that keeps the upload small on mobile data, gives the
 * server the one content type it expects whatever the phone stored (HEIC, PNG), and drops
 * the file's EXIF — GPS included — because a canvas carries only pixels.
 */
export function GalleryPick({ onPick }: { onPick: (blob: Blob) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function picked(file: File | undefined) {
    setError(null);
    if (!file) return;
    try {
      // `imageOrientation` applies the EXIF rotation into the pixels, so a portrait photo
      // is not uploaded on its side once the EXIF is gone.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const blob = await toJpeg(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      if (!blob) throw new Error('encode');
      onPick(blob);
    } catch {
      setError('That file could not be read as a photograph. Please choose another.');
    } finally {
      // Choosing the same file again should fire `change` again.
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void picked(event.target.files?.[0])}
      />
      <button type="button" className="gb-btn gb-btn--block" onClick={() => input.current?.click()}
      >
        Choose from gallery
      </button>
      {error ? <p className="gb-field-error" role="alert">{error}</p> : null}
    </>
  );
}

/**
 * Draws an image to a canvas at no more than a 1920 px long edge and encodes it as JPEG at
 * ~80 % — what the mobile capture path does (STACK.md §5). A 12 MP frame over mobile data
 * is the difference between a submission that completes and one that times out.
 */
export function toJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

/**
 * Storage URLs, made safe for a page served over HTTPS.
 *
 * A LAN test setup mints `http://192.168.x.x:3000/...` for uploads and for the before photo,
 * and a browser blocks both from an HTTPS page as mixed content. The presigned signature
 * covers the method, the object key and the expiry — **never the host** — so the path is
 * taken as it stands and addressed to this page's own origin, which proxies `/api` to the
 * API. Off an HTTPS page, or for a URL already secure, nothing changes.
 */
export function sameOriginWhenSecure(url: string): string {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return url;
  try {
    const target = new URL(url, window.location.href);
    return target.protocol === 'https:' ? url : `${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

/**
 * An identifier, on an origin that may not be a secure context.
 *
 * `crypto.randomUUID` is secure-context-only, and this page is opened from a link in a
 * PDF — whatever address the report happened to be generated against. On a plain
 * `http://192.168.x.x` that property is `undefined`, and because the id was minted during
 * render the whole form threw and the reader got a blank white page. They had followed a
 * link from an audit report and arrived at nothing, with no way to tell whether their
 * earlier answer had been lost.
 *
 * `getRandomValues` carries no such restriction, so the fallback is a version 4 UUID built
 * from it: the same 122 bits of entropy, which is what an idempotency key needs. The
 * camera and the checksum still require HTTPS and still say so — but Option B, which needs
 * neither, now works instead of taking the page down with it.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Lowercase hex SHA-256, as `upload-intent` and `commit` expect. Needs a secure context. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!crypto.subtle) throw new Error('This page must be opened over HTTPS before a photograph can be sent.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The presigned PUT, straight to storage: media never transits the API. */
export async function putObject(uploadUrl: string, headers: Record<string, string>, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const put = await fetch(sameOriginWhenSecure(uploadUrl), { referrerPolicy: 'no-referrer', method: 'PUT', headers, body: bytes });
  if (!put.ok) throw new Error('The photograph could not be uploaded. Check your connection.');
}
