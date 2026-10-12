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
import { newId, PhotoPicker, sameOriginWhenSecure } from '@/lib/photo';

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
 * §9.4's upload, from a page with no session.
 *
 * Intent → PUT straight to storage. The bytes never pass through the API, which is the same
 * rule the mobile app follows and the reason `upload-intent` exists at all.
 *
 * The **commit** is not here. It is an authenticated call, and this page has no session;
 * the submission endpoint performs it server-side instead, so the link still authorizes
 * only what §10.4 says it does. See `PublicCorrectiveActionsService.submit`.
 */
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
