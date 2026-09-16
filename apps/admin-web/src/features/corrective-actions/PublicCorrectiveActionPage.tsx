import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CorrectiveActionSubmission,
  ProblemDetails,
  PublicCorrectiveAction,
  UploadIntentResponse,
} from '@audit5s/contracts';
import { sectionLabel } from '@audit5s/domain';

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
 *   * The camera is `getUserMedia` and there is **no file picker** — no `<input
 *     type="file">` anywhere in this file. §12.10 is honest that a determined user on a
 *     desktop browser can present a virtual camera; the point is that the ordinary path
 *     offers no way to attach yesterday's photograph, and the server refuses anything not
 *     flagged as a live capture regardless.
 *   * Every failure says what to do next. "This link is no longer valid" with a path to
 *     ask for a new one — never a silent failure a Zone Leader would read as "the system
 *     lost my work".
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

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
      const response = await fetch(`${BASE_URL}/public/corrective-actions/${token}`, NO_REFERRER);
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
    return <Shell><p className="text-ink-2">Loading…</p></Shell>;
  }

  if (state.status === 'gone') {
    return (
      <Shell>
        <h1 className="gb-h1">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-ink-2">
          It may have expired, or it may have been replaced. Ask the auditor or your
          Super Admin for a new corrective-action link — nothing you have done has been lost.
        </p>
      </Shell>
    );
  }

  if (state.status === 'error' || !state.item) {
    return (
      <Shell>
        <h1 className="gb-h1">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink-2">{state.message}</p>
      </Shell>
    );
  }

  if (state.status === 'done') {
    return (
      <Shell>
        <div className="gb-panel p-4">
          <h1 className="gb-h1">Thank you — that is submitted</h1>
          <p className="mt-2 text-sm text-ink-2">
            Your response has been recorded and sent for review. You may close this page.
          </p>
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
        <p className="border border-edge-soft bg-board p-4 text-sm text-ink-2">
          This item has been verified and is closed. Nothing further is needed.
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
    <div className="min-h-screen bg-tile-2">
      <header className="bg-ink px-4 py-4 text-board">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center bg-ink text-sm font-bold">
            5S
          </span>
          <div>
            <div className="gb-h2">Corrective action</div>
            <div className="text-xs opacity-90">AB Associates — Operations Consulting</div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 p-4">{children}</main>
    </div>
  );
}

function Finding({ item }: { item: PublicCorrectiveAction }) {
  return (
    <section className="border border-edge-soft bg-tile p-4">
      <h1 className="gb-h1">
        {item.questionGlobalOrder ? `Q${item.questionGlobalOrder}. ` : ''}
        {item.questionText ?? 'Walk-by observation'}
      </h1>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Detail label="Unit" value={item.unitName} />
        <Detail label="Zone" value={`${item.zoneCode} — ${item.zoneName}`} />
        <Detail label="Audit date" value={formatDate(item.auditDate)} />
        <Detail label="Auditor" value={item.auditorName} />
        {item.section ? <Detail label="Section" value={sectionLabel(item.section)} /> : null}
        {item.dueAt ? <Detail label="Due by" value={formatDate(item.dueAt)} /> : null}
      </dl>

      {item.findingRemark ? (
        <p className="mt-3 border-l-4 border-edge bg-board p-3 text-sm text-ink">
          {item.findingRemark}
        </p>
      ) : null}

      {item.beforePhotoUrl ? (
        <figure className="mt-3">
          <img
            src={item.beforePhotoUrl}
            alt="The finding as it was recorded"
            className="w-full border border-edge-soft"
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
          A response was already submitted on {formatDate(item.alreadySubmitted.submittedAt)}. You
          may submit again if it was reopened.
        </p>
      ) : null}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
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
  const [option, setOption] = useState<Option>('COMPLETED');
  const [name, setName] = useState(item.issuedToName ?? '');
  const [description, setDescription] = useState('');
  const [explanation, setExplanation] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Minted when the form opens, not when the photo is taken: §5.6 puts it in the object
  // key, and a replayed submission has to find its own attempt rather than make a new one.
  const submissionId = useRef(crypto.randomUUID());

  const acceptPhoto = useCallback((blob: Blob) => {
    setPhoto(blob);
    setPhotoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(blob);
    });
  }, []);

  async function submit() {
    setError(null);

    if (option === 'COMPLETED' && (!photo || !name.trim() || !description.trim())) {
      setError('Option A needs your name, a description, and a photograph of the work.');
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
        afterEvidenceId = await uploadAfterPhoto(token, submissionId.current, photo);
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
            : { option, id: submissionId.current, explanation: explanation.trim() },
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
    } catch {
      // The network, not the server. Saying so matters: the work is not lost, and a retry
      // with the same id cannot create a second attempt.
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-edge-soft bg-tile p-4">
      <h2 className="text-base font-semibold text-ink">Your response</h2>

      <div className="mt-3 flex gap-2">
        <OptionTab active={option === 'COMPLETED'} onClick={() => setOption('COMPLETED')}>
          A — Done
        </OptionTab>
        <OptionTab active={option === 'NOT_POSSIBLE'} onClick={() => setOption('NOT_POSSIBLE')}>
          B — Not possible
        </OptionTab>
      </div>

      {option === 'COMPLETED' ? (
        <div className="mt-4 space-y-3">
          <Labelled label="Your name">
            <input
              className="gb-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
            />
          </Labelled>

          <Labelled label="Photograph of the completed work">
            <LiveCapture onCapture={acceptPhoto} preview={photoUrl} />
          </Labelled>

          <Labelled label="What was done">
            <textarea
              className="gb-input"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Labelled>
        </div>
      ) : (
        <div className="mt-4">
          <Labelled label="Why is this not possible?">
            <textarea
              className="gb-input"
              rows={4}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              placeholder="e.g. Requires vendor approval; PO raised 12 Sep."
            />
          </Labelled>
          <p className="mt-2 text-xs text-ink-2">
            This is reviewed like any other response. Being unable to act is a valid answer;
            leaving the item unanswered is not.
          </p>
        </div>
      )}

      {error ? (
        <p className="gb-notice mt-3">
          {error}
        </p>
      ) : null}

      <button
        className="mt-4 w-full bg-ink px-4 py-3 text-base font-semibold text-board disabled:opacity-50"
        onClick={submit}
        disabled={busy}
      >
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </section>
  );
}

/**
 * The camera (§10.4, §12.10).
 *
 * `getUserMedia` with the rear camera where there is one, drawn to a canvas and encoded as
 * JPEG. **There is no `<input type="file">` in this component and there must not be**: the
 * whole point of the flow is that the photograph is taken now, in front of the thing that
 * was fixed.
 *
 * A refused or absent camera is reported plainly rather than silently falling back to an
 * upload — falling back would quietly turn a live-capture requirement into a suggestion,
 * and the server would refuse the result anyway.
 */
function LiveCapture({
  onCapture,
  preview,
}: {
  onCapture: (blob: Blob) => void;
  preview: string | null;
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
      setError('This browser cannot open a camera. Please use your phone’s browser.');
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
        'The camera could not be opened. Allow camera access for this page, then try again.',
      );
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;

    // Downscaled to a 1920 px long edge before it leaves the page, matching what the
    // mobile capture path does (STACK.md §5) — a 12 MP frame over mobile data is the
    // difference between a submission that completes and one that times out.
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(blob);
          stop();
        }
      },
      'image/jpeg',
      0.8,
    );
  }

  if (preview && !live) {
    return (
      <div className="space-y-2">
        <img
          src={preview}
          alt="The work you photographed"
          className="w-full border border-edge-soft"
          referrerPolicy="no-referrer"
        />
        <button
          type="button"
          className="w-full border border-edge px-3 py-2 text-sm"
          onClick={start}
        >
          Retake
        </button>
      </div>
    );
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
        <button
          type="button"
          className="w-full bg-ink px-4 py-3 text-base font-semibold text-board"
          onClick={capture}
        >
          Take the photograph
        </button>
      ) : (
        <button
          type="button"
          className="w-full border border-edge px-3 py-3 text-sm"
          onClick={start}
        >
          Open the camera
        </button>
      )}
      {error ? <p className="gb-field-error">{error}</p> : null}
      <p className="text-xs text-ink-2">
        The photograph is taken here, now. There is no option to attach an existing file.
      </p>
    </div>
  );
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
async function uploadAfterPhoto(token: string, submissionId: string, photo: Blob): Promise<string> {
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const checksumSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const evidenceId = crypto.randomUUID();

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
        // Set here and nowhere else, by the component that owns the camera (§12.10).
        isLiveCapture: true,
      }),
    },
  );

  if (!intentResponse.ok) {
    const problem = (await intentResponse.json().catch(() => null)) as ProblemDetails | null;
    throw new Error(problem?.detail ?? 'The photograph could not be prepared for upload.');
  }

  const intent = (await intentResponse.json()) as UploadIntentResponse;

  // Cross-origin, to object storage. `no-referrer` is load-bearing here, not hygiene.
  const put = await fetch(intent.uploadUrl, {
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
      className={
        'flex-1 border px-3 py-2 text-sm font-medium ' +
        (active
          ? 'border-edge bg-ink text-board'
          : 'border-edge bg-tile text-ink-2')
      }
    >
      {children}
    </button>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}
