import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CorrectiveActionDetail, CorrectiveActionSubmission } from '@audit5s/contracts';
import { uuidv7 } from '@audit5s/domain';
import { Button, ErrorNotice, Field, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { uploadEvidence } from '@/lib/evidence';
import { PhotoPicker } from '@/lib/photo';
import { useSession } from '@/lib/session';

/**
 * A signed-in Zone Leader answers a nonconformity here, as on the phone
 * (`actions/[actionId].tsx`) and the PDF's link page: Option A is what was done and a
 * photograph of it, Option B why it cannot be done. An overall action (R-38) is answered
 * with what was done, and its photograph is optional. Either photograph may come from the
 * camera or a file (R-40). Submitted as `WEB_SESSION` under the account's own name.
 */
export function AnswerForm({ action, onDone }: { action: CorrectiveActionDetail; onDone: () => Promise<void> }) {
  const { user } = useSession();
  const overall = Boolean(action.suggestion);
  const [option, setOption] = useState<'COMPLETED' | 'NOT_POSSIBLE'>('COMPLETED');
  const [description, setDescription] = useState('');
  const [explanation, setExplanation] = useState('');
  const [photo, setPhoto] = useState<{ blob: Blob; url: string; live: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Minted when the form opens: the after-photo's object key embeds it (§5.6), and a retry
  // must find its own attempt rather than make a second one.
  const submissionId = useRef(uuidv7());

  const submit = useMutation({
    mutationFn: async () => {
      if (option === 'NOT_POSSIBLE') {
        return api.post<CorrectiveActionSubmission>(
          `/corrective-actions/${action.id}/submissions`,
          { option, id: submissionId.current, explanation: explanation.trim() },
          submissionId.current,
        );
      }
      const afterEvidenceId = photo
        ? await uploadEvidence(photo.blob, {
            kind: 'CORRECTIVE_AFTER',
            auditId: action.auditId,
            correctiveActionId: action.id,
            correctiveActionSubmissionId: submissionId.current,
            isLiveCapture: photo.live,
          })
        : undefined;
      return api.post<CorrectiveActionSubmission>(
        `/corrective-actions/${action.id}/submissions`,
        {
          option,
          id: submissionId.current,
          submittedByName: user?.fullName ?? '',
          description: description.trim(),
          ...(afterEvidenceId ? { afterEvidenceId } : {}),
        },
        submissionId.current,
      );
    },
    onSuccess: onDone,
  });

  const send = () => {
    setProblem(null);
    if (option === 'NOT_POSSIBLE' && !explanation.trim()) return setProblem('Explain why this cannot be done.');
    if (option === 'COMPLETED' && !description.trim()) return setProblem(overall ? 'Describe what was done.' : 'Option A needs a description of the work.');
    if (option === 'COMPLETED' && !overall && !photo) return setProblem('Option A needs a photograph of the completed work.');
    submit.mutate();
  };

  return (
    <div className="space-y-3 border border-edge-soft p-3">
      <p className="gb-label">Your answer</p>
      {overall ? null : (
        <Segmented
          label="Answer"
          options={[
            { value: 'COMPLETED', label: 'A — Done' },
            { value: 'NOT_POSSIBLE', label: 'B — Not possible' },
          ]}
          value={option}
          onChange={setOption}
        />
      )}
      {option === 'COMPLETED' ? (
        <>
          <div>
            <span className="gb-label mb-1 block">{overall ? 'Photograph (optional)' : 'Photograph of the completed work'}</span>
            <PhotoPicker
              photoUrl={photo?.url ?? null}
              onPhoto={(blob, live) => {
                if (photo) URL.revokeObjectURL(photo.url);
                setPhoto({ blob, url: URL.createObjectURL(blob), live });
              }}
              onRemove={() => {
                if (photo) URL.revokeObjectURL(photo.url);
                setPhoto(null);
              }}
              hint={overall ? 'Take a photograph or choose a file. If the fix cannot be photographed, leave this empty.' : 'Take a photograph now, or choose a file.'}
            />
          </div>
          <Field label={overall ? 'Corrective action taken' : 'What was done'}>
            <textarea className="gb-input" rows={3} maxLength={4000} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="Why is this not possible?" hint="Reviewed like any other answer.">
          <textarea className="gb-input" rows={3} maxLength={4000} value={explanation} onChange={(event) => setExplanation(event.target.value)} />
        </Field>
      )}
      {problem ? (
        <p className="gb-field-error" role="alert">
          {problem}
        </p>
      ) : null}
      <ErrorNotice error={submit.error} />
      <Button disabled={submit.isPending} onClick={send}>
        {submit.isPending ? 'Submitting…' : 'Submit answer'}
      </Button>
    </div>
  );
}
