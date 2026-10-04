import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CorrectiveActionSubmission,
  ProblemDetails,
  PublicCorrectiveAction,
  UploadIntentResponse,
} from '@audit5s/contracts';
import { formatDate, sectionLabel } from '@audit5s/domain';
// The address only — not the client, which carries a session this page must never send.
import { BASE_URL } from '@/lib/api';
import { Field } from '@/components/ui';

/**
 * The live corrective-action page — `/ca/{token}` (§10.4, PART 14 Phase 7's Web row).
 *
 * **This is the only page in the product a person outside the organization opens**, and
 * everything about it follows from that:
 *
 *   * It does **not** use the shared API client. That client carries a bearer token,
 *     refreshes it, and clears a session on 401 — none of which applies here, and all of
 *     which would be a way for a signed-in Super Admin's session to leak into a page a
 *     stranger is holding. This page talks to three endpoints with plain `fetch` and no
 *     credentials, which is exactly what the server expects.
 *   * It is **responsive first**. The reader is a Zone Leader standing in front of the
 *     thing they just fixed, on a phone, probably on mobile data.
 *   * The after-photo may come from the **camera** (`getUserMedia`) or the **gallery**
 *     (R-38 for an overall action, widened to findings by R-40). A Zone Leader often takes
 *     the photograph with the phone's own camera app first, or cannot give the browser
 *     camera access. `isLiveCapture` records honestly which it was.
 *   * For a **finding** the photograph is required; for an **overall action** — the
 *     auditor's suggestion for the Zone as a whole — it is optional, because some fixes
 *     cannot be photographed at all (a smell).
 *   * **Links in PDFs already issued keep working.** The route, the token and the three
 *     endpoints are unchanged; an old link simply opens this page as it now is.
 *   * Every failure says what to do next. "This link is no longer valid" with a path to
 *     ask for a new one — never a silent failure a Zone Leader would read as "the system
 *     lost my work".
 */

/**
 * **The token is in this page's URL, so no request may carry a referrer.**
 *
 * A presigned PUT and a presigned GET both go to object storage — a different origin — and
 * a browser's default `Referer` on a cross-origin request would be
 * `https://app/ca/{secret}`. That hands the secret to the storage provider's access logs,
 * and to anyone who can read them, from a page whose whole security model is that the
 * secret exists only in the link.
 *
 * Applied to every `fetch` here and to every `<img>`, plus a document-level meta below, so
 * a future request added to this file inherits it rather than having to remember.
 */
const NO_REFERRER = { referrerPolicy: 'no-referrer' } as const;

type Option = 'COMPLETED' | 'NOT_POSSIBLE';

interface PageState {
  status: 'loading' | 'ready' | 'gone' | 'error' | 'done';
  item?: PublicCorrectiveAction;
  message?: string;
}

export function PublicCorrectiveActionPage({ token }: { token: string }) {
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let response: Response;
      try {
        response =
          import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst'
            ? (await import('./public-worst-case')).publicWorstCase(token)
            : await fetch(`${BASE_URL}/public/corrective-actions/${token}`, NO_REFERRER);
      } catch {
        // Offline or the server unreachable: without this the page sat on "Loading…" forever.
        if (!cancelled) {
          setState({ status: 'error', message: 'Could not reach the server. Check your connection and try again.' });
        }
        return;
      }
      if (cancelled) return;

      if (response.status === 410) {
        setState({ status: 'gone' });
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
        setState({ status: 'error', message: problem?.detail ?? 'This page could not be loaded.' });
        return;
      }
      setState({ status: 'ready', item: (await response.json()) as PublicCorrectiveAction });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'loading') {
    return <Shell><p className="text-ink-2" role="status">Loading…</p></Shell>;
  }

  if (state.status === 'gone') {
    return (
      <Shell>
        {/* Expired, replaced and never-issued are one answer on purpose (report-tokens.service):
            telling them apart would tell a prober which guesses were close. */}
        <div className="gb-panel p-4">
          <h1 className="gb-h1">This link isn't valid</h1>
          <p className="mt-2 text-ink-2">
            It may have expired, been replaced by a newer link, or been copied incompletely.
            Ask the auditor, or whoever sent it to you, for a new corrective-action link.
            Nothing you have already sent has been lost.
          </p>
        </div>
      </Shell>
    );
  }

  // Before the error branch: `done` carries no item, and checked after it a successful
  // submission rendered "Something went wrong" although the answer had been saved.
  if (state.status === 'done') {
    return (
      <Shell>
        <div className="gb-panel p-4">
          <h1 className="gb-h1">Thank you — that is submitted</h1>
          <p className="mt-2 text-ink-2">
            Your response has been recorded and the Super Admin has been notified. You may
            close this page.
          </p>
        </div>
      </Shell>
    );
  }

  if (state.status === 'error' || !state.item) {
    return (
      <Shell>
        <div className="gb-panel p-4">
          <h1 className="gb-h1">Something went wrong</h1>
          <p className="mt-2 text-ink-2">{state.message}</p>
          <button
            type="button"
            className="gb-btn gb-btn--block mt-4"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Finding item={state.item} />
      {state.item.submittable ? (
        <SubmitForm
          token={token}
          item={state.item}
          onDone={() => setState({ status: 'done' })}
          onGone={() => setState({ status: 'gone' })}
        />
      ) : (
        <p className="gb-panel p-4 text-ink-2">
          {state.item.status === 'VERIFIED'
            ? 'This item has been answered and is closed. Nothing further is needed.'
            : 'A response to this item has been received and is waiting for review. Nothing more is needed unless it is reopened.'}
        </p>
      )}
    </Shell>
  );
}

/** The ink header band, the card, and a page that works at 360 px. */
function Shell({ children }: { children: React.ReactNode }) {
  // Document-level, for anything a browser fetches that is not one of the calls above —
  // and so that this page's URL never reaches another origin even by accident.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  return (
    // No background of its own: the board's grid (the body's) shows through, as on every
    // other screen. The mark is the portal's (P1), not a stand-in "5S" box.
    <div className="gb-ca">
      <header className="border-b-2 border-edge bg-tile-2 px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <img src="/audit5s-logo.png" alt="audit5s" width="36" height="36" />
          <div className="min-w-0">
            <div className="gb-h2">Corrective action</div>
            <div className="gb-label">AB Associates — Operations Consulting</div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-5 p-4 pb-8">{children}</main>
    </div>
  );
}

function Finding({ item }: { item: PublicCorrectiveAction }) {
  // R-38: an overall action answers the auditor's sentence, not a photograph.
  const overall = Boolean(item.suggestion);
  return (
    <section className="gb-panel p-4">
      {overall ? (
        <>
          <div className="gb-label">Overall corrective action suggested by the auditor</div>
          <h1 className="gb-ca-q mt-1 whitespace-pre-wrap">{item.suggestion}</h1>
        </>
      ) : (
        <h1 className="gb-ca-q">
          {item.questionGlobalOrder ? `Q${item.questionGlobalOrder}. ` : ''}
          {item.questionText ?? 'Walk-by observation'}
        </h1>
      )}
      <dl className="mt-4 grid gap-x-4 gap-y-3 text-sm min-[480px]:grid-cols-2">
        <Detail label="Unit" value={item.unitName} />
        <Detail label="Zone" value={`${item.zoneCode} — ${item.zoneName}`} />
        <Detail label="Audit date" value={formatDate(item.auditDate)} />
        <Detail label="Auditor" value={item.auditorName} />
        {item.section ? <Detail label="Section" value={sectionLabel(item.section)} /> : null}
        {item.dueAt ? <Detail label="Due by" value={formatDate(item.dueAt)} /> : null}
      </dl>

      {item.findingRemark ? (
        <p className="mt-4 border-l-4 border-edge bg-board p-3 text-sm text-ink [overflow-wrap:anywhere]">
          {item.findingRemark}
        </p>
      ) : null}

      {overall ? null : item.beforePhotoUrl ? (
        <figure className="mt-3">
          <img
            src={sameOriginWhenSecure(item.beforePhotoUrl)}
            alt="The finding as it was recorded"
            className="max-h-[70vh] w-full border border-edge-soft bg-board object-contain"
            referrerPolicy="no-referrer"
          />
          <figcaption className="mt-1 text-xs text-ink-2">What the auditor saw</figcaption>
        </figure>
      ) : (
        <p className="mt-3 border border-dashed border-edge p-4 text-center text-sm text-ink-3">
          Photo not available
        </p>
      )}

      {item.alreadySubmitted ? (
        <p className="gb-slip mt-3">
          A response was already submitted on {formatDate(item.alreadySubmitted.submittedAt)}.
          {item.submittable
            ? ' That response was removed and a new one is needed — please answer it again below.'
            : ''}
        </p>
      ) : null}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="gb-label">{label}</dt>
      <dd className="font-medium text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function SubmitForm({
  token,
  item,
  onDone,
  onGone,
}: {
  token: string;
  item: PublicCorrectiveAction;
  onDone: () => void;
  onGone: () => void;
}) {
  // R-38: an overall action is answered with what was done; the photograph is optional.
  // There is no "not possible" branch for it. Any photograph may come from the gallery (R-40).
  const overall = Boolean(item.suggestion);
  const [option, setOption] = useState<Option>('COMPLETED');
  const [name, setName] = useState(item.issuedToName ?? '');
  const [description, setDescription] = useState('');
  const [explanation, setExplanation] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  // Whether the photograph came from the camera on this page. Sent as `isLiveCapture`, so
  // the record says honestly which it was.
  const [photoIsLive, setPhotoIsLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Minted when the form opens, not when the photo is taken: §5.6 puts it in the object
  // key, and a replayed submission has to find its own attempt rather than make a new one.
  const submissionId = useRef(newId());

  const acceptPhoto = useCallback((blob: Blob, live = true) => {
    setPhoto(blob);
    setPhotoIsLive(live);
    setPhotoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(blob);
    });
  }, []);

  const removePhoto = useCallback(() => {
    setPhoto(null);
    setPhotoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, []);

  async function submit() {
    setError(null);

    // Anyone with the link may answer (R-22), so the name is how the answer is attributed.
    if (!name.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (overall && !description.trim()) {
      setError('Please describe the corrective action you have taken.');
      return;
    }
    if (!overall && option === 'COMPLETED' && (!photo || !description.trim())) {
      setError('Option A needs a description and a photograph of the work.');
      return;
    }
    if (option === 'NOT_POSSIBLE' && !explanation.trim()) {
      setError('Please explain why this cannot be done.');
      return;
    }

    setBusy(true);
    try {
      let afterEvidenceId: string | undefined;

      if (option === 'COMPLETED' && photo) {
        afterEvidenceId = await uploadAfterPhoto(token, submissionId.current, photo, photoIsLive);
      }

      const response = await fetch(`${BASE_URL}/public/corrective-actions/${token}/submissions`, {
        ...NO_REFERRER,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': submissionId.current },
        body: JSON.stringify(
          option === 'COMPLETED'
            ? {
                option,
                id: submissionId.current,
                submittedByName: name.trim(),
                description: description.trim(),
                afterEvidenceId,
              }
            : {
                option,
                id: submissionId.current,
                submittedByName: name.trim(),
                explanation: explanation.trim(),
              },
        ),
      });

      if (response.status === 410) {
        onGone();
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
        setError(problem?.detail ?? 'That could not be submitted. Please try again.');
        return;
      }

      (await response.json()) as CorrectiveActionSubmission;
      onDone();
    } catch (caught) {
      // `fetch` rejects with a TypeError only when the network failed; the photo upload
      // throws an Error carrying the server's own sentence, which must be shown as it is
      // rather than disguised as a connection problem. Either way nothing is lost, and a
      // retry with the same id cannot create a second attempt.
      setError(
        caught instanceof TypeError || !(caught instanceof Error)
          ? 'Could not reach the server. Check your connection and try again.'
          : caught.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gb-panel p-4">
      <h2 className="gb-h2">Your response</h2>

      {overall ? null : (
        <div className="mt-3 flex gap-3">
          <OptionTab active={option === 'COMPLETED'} onClick={() => setOption('COMPLETED')}>
            A — Done
          </OptionTab>
          <OptionTab active={option === 'NOT_POSSIBLE'} onClick={() => setOption('NOT_POSSIBLE')}>
            B — Not possible
          </OptionTab>
        </div>
      )}

      {/* Both answers carry a name: anyone holding the link may answer it (R-22). */}
      <div className="mt-4">
        <Field label="Your name">
          <input
            className="gb-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
          />
        </Field>
      </div>

      {overall ? (
        <div className="mt-4 space-y-3">
          <Field label="Corrective action taken">
            <textarea
              className="gb-input"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. Found the leaking drain, sealed it and cleaned the pit."
            />
          </Field>

          <div>
            <span className="gb-label mb-1 block">Photograph (optional)</span>
            <PhotoPicker
              photoUrl={photoUrl}
              onPhoto={acceptPhoto}
              onRemove={removePhoto}
              hint="Take a photograph or choose one from your gallery. If the fix cannot be photographed, leave this empty."
            />
          </div>
        </div>
      ) : option === 'COMPLETED' ? (
        <div className="mt-4 space-y-3">
          {/* A <div>, not `Field`: a <label> forwards a tap on its text to the first
              control inside it, which here would open the camera. */}
          <div>
            <span className="gb-label mb-1 block">Photograph of the completed work</span>
            <PhotoPicker
              photoUrl={photoUrl}
              onPhoto={acceptPhoto}
              onRemove={removePhoto}
              hint="Take a photograph now, or choose one from your gallery."
            />
          </div>

          <Field label="What was done">
            <textarea
              className="gb-input"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      ) : (
        <div className="mt-4">
          <Field label="Why is this not possible?">
            <textarea
              className="gb-input"
              rows={4}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              placeholder="e.g. Requires vendor approval; PO raised 12 Sep."
            />
          </Field>
          <p className="mt-2 text-xs text-ink-2">
            This is reviewed like any other response. Being unable to act is a valid answer;
            leaving the item unanswered is not.
          </p>
        </div>
      )}

      {error ? (
        <p className="gb-notice mt-3" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="gb-btn gb-btn--primary gb-btn--block mt-5"
        onClick={submit}
        disabled={busy}
      >
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </section>
  );
}

/**
 * The after-photo: the chosen one with *Remove photograph*, or else the camera and the
 * gallery one above the other (R-38, R-40). Removing it brings both options back.
 */
function PhotoPicker({
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
function LiveCapture({ onCapture }: { onCapture: (blob: Blob) => void }) {
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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
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
          Open the camera
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
function GalleryPick({ onPick }: { onPick: (blob: Blob) => void }) {
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
function toJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

/**
 * §9.4's upload, from a page with no session.
 *
 * Intent → PUT straight to storage. The bytes never pass through the API, which is the same
 * rule the mobile app follows and the reason `upload-intent` exists at all.
 *
 * The **commit** is not here. It is an authenticated call, and this page has no session;
 * the submission endpoint performs it server-side instead, so the link still authorizes
 * only what §10.4 says it does. See `PublicCorrectiveActionsService.submit`.
 */
/**
 * Storage URLs, made safe for a page served over HTTPS.
 *
 * A LAN test setup mints `http://192.168.x.x:3000/...` for uploads and for the before photo,
 * and a browser blocks both from an HTTPS page as mixed content. The presigned signature
 * covers the method, the object key and the expiry — **never the host** — so the path is
 * taken as it stands and addressed to this page's own origin, which proxies `/api` to the
 * API. Off an HTTPS page, or for a URL already secure, nothing changes.
 */
function sameOriginWhenSecure(url: string): string {
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
function newId(): string {
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

async function uploadAfterPhoto(
  token: string,
  submissionId: string,
  photo: Blob,
  /** False for a photo chosen from the gallery (R-38, R-40). */
  isLiveCapture: boolean,
): Promise<string> {
  const bytes = new Uint8Array(await photo.arrayBuffer());
  if (!crypto.subtle) {
    // A gallery photo can now reach here on a plain-HTTP page, where the camera cannot. A
    // raw "cannot read properties of undefined" would be caught below and shown to a Zone
    // Leader as a network failure, so this says what is actually wrong.
    throw new Error('This page must be opened over HTTPS before a photograph can be sent.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const checksumSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const evidenceId = newId();

  const intentResponse = await fetch(
    `${BASE_URL}/public/corrective-actions/${token}/upload-intent`,
    {
      ...NO_REFERRER,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': evidenceId },
      body: JSON.stringify({
        id: evidenceId,
        kind: 'CORRECTIVE_AFTER',
        // Overwritten server-side from the token; sent so the shape is the shared one.
        auditId: evidenceId,
        correctiveActionSubmissionId: submissionId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256,
        capturedAt: new Date().toISOString(),
        // True only for a frame from `LiveCapture`; a gallery photo says so (R-40).
        isLiveCapture,
      }),
    },
  );

  if (!intentResponse.ok) {
    const problem = (await intentResponse.json().catch(() => null)) as ProblemDetails | null;
    throw new Error(problem?.detail ?? 'The photograph could not be prepared for upload.');
  }

  const intent = (await intentResponse.json()) as UploadIntentResponse;

  // Cross-origin, to object storage. `no-referrer` is load-bearing here, not hygiene.
  const put = await fetch(sameOriginWhenSecure(intent.uploadUrl), {
    ...NO_REFERRER,
    method: 'PUT',
    headers: intent.requiredHeaders,
    body: bytes,
  });
  if (!put.ok) {
    throw new Error('The photograph could not be uploaded. Check your connection.');
  }

  return intent.evidenceId;
}

function OptionTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={active ? 'gb-btn gb-btn--primary flex-1' : 'gb-btn flex-1'}
    >
      {children}
    </button>
  );
}
