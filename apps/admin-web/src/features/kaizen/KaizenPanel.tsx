import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KaizenDetail, KaizenExport, KaizenPhoto, KaizenReviewDecision } from '@audit5s/contracts';
import { formatDate, formatDateTime, formatRupees, zoneDisplayLabel } from '@audit5s/domain';
import { Button, ErrorNotice, Field, SidePanel, Spinner, StatusChip } from '@/components/ui';
import { api } from '@/lib/api';
import { KAIZEN_PARAMETER_LABEL, KAIZEN_STATUS_LABEL, KAIZEN_WASTE_LABEL, roleLabel } from '@/lib/labels';
import { useFollowItemUnit } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { savePdf } from '@/features/reports/report-pdf';

/**
 * One Kaizen beside its list (§4.4): the sheet top to bottom with before and after side by
 * side, every review with its reason, the Coordinator's Review, and the Kaizen Sheet PDF.
 * Opened by `?kaizen=<id>`, so it can be linked and Back closes it.
 */
export function KaizenPanel({ kaizenId, onClose }: { kaizenId: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['kaizen', kaizenId],
    queryFn: () => api.get<KaizenDetail>(`/kaizens/${kaizenId}`),
    enabled: kaizenId !== null,
  });
  const kaizen = detail.data;
  useFollowItemUnit(kaizenId, kaizen?.id === kaizenId ? kaizen.unitId : undefined);

  return (
    <SidePanel
      open={kaizenId !== null}
      title={kaizen?.kaizenNo ?? 'Kaizen'}
      subtitle={kaizen ? `${zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName)} · ${kaizen.authorName}` : undefined}
      onClose={onClose}
    >
      {detail.isLoading && <Spinner />}
      {detail.error && <ErrorNotice error={detail.error} missing="This Kaizen doesn't exist, or is outside your Units." />}
      {kaizen && <KaizenSheet key={kaizen.id} kaizen={kaizen} />}
    </SidePanel>
  );
}

function KaizenSheet({ kaizen }: { kaizen: KaizenDetail }) {
  const rows: [string, string | null][] = [
    ['Machine', kaizen.machine],
    ['Line / area', kaizen.lineArea],
    ['Department', kaizen.department],
    ['Implemented on', kaizen.implementedOn ? formatDate(kaizen.implementedOn) : null],
    ['Team members', kaizen.teamMembers],
    ['Target & target date', kaizen.target],
    ['Problem [5W1H]', kaizen.problem5w1h],
    ['Root cause [4M]', kaizen.rootCause4m],
    ['Analysis [7 QC tools]', kaizen.analysis7qc],
    ['Countermeasure', kaizen.countermeasure],
    ['Waste attacked', kaizen.wastes.length ? kaizen.wastes.map((w) => KAIZEN_WASTE_LABEL[w]).join(', ') : null],
    ['Parameters', kaizen.parameters.length ? kaizen.parameters.map((p) => KAIZEN_PARAMETER_LABEL[p]).join(', ') : null],
    ['Horizontal deployment', kaizen.horizontalDeployment === null ? null : kaizen.horizontalDeployment ? 'Yes' : 'No'],
    ['Benefits / results', kaizen.benefits],
    ['Annual saving', kaizen.annualSaving === null ? null : formatRupees(kaizen.annualSaving)],
    ['Idea given by', kaizen.ideaBy],
    ['Implemented by', kaizen.implementedBy],
    ['Submitted', kaizen.submittedAt ? formatDateTime(kaizen.submittedAt) : null],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip kind="kaizen" status={kaizen.status} />
      </div>
      <p className="text-lg font-bold text-ink">{kaizen.theme ?? '—'}</p>

      <div className="gb-kz-photos">
        <PhotoBox label="Before" photo={kaizen.beforePhoto} />
        <PhotoBox label="After" photo={kaizen.afterPhoto} />
      </div>

      <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {rows
          .filter((row): row is [string, string] => Boolean(row[1]))
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd className="whitespace-pre-wrap text-ink">{value}</dd>
            </div>
          ))}
      </dl>

      <div className="space-y-2">
        <p className="gb-label">Reviews ({kaizen.reviews.length})</p>
        {kaizen.reviews.length === 0 && <p className="text-sm text-ink-2">Not reviewed yet.</p>}
        {kaizen.reviews.map((review) => (
          <div key={review.id} className="border border-edge-soft p-3 text-sm">
            <p className="text-ink">
              <b>{KAIZEN_STATUS_LABEL[review.decision]}</b> by {review.reviewerName} ({roleLabel(review.reviewerRole)}) ·{' '}
              <span className="gb-data">{formatDateTime(review.createdAt)}</span>
            </p>
            {review.comment && <p className="mt-1 whitespace-pre-wrap text-ink-2">{review.comment}</p>}
          </div>
        ))}
      </div>

      <Review kaizen={kaizen} />
      {kaizen.status !== 'DRAFT' && <ExportButton kaizen={kaizen} />}
    </div>
  );
}

/** The photo, its server URL short-lived (≤ 5 min); a missing one is the hatch, never blank. */
function PhotoBox({ label, photo }: { label: string; photo: KaizenPhoto | null }) {
  return (
    <figure className="m-0 space-y-1">
      <figcaption className="gb-label">{photo ? label : `${label} · none`}</figcaption>
      <div className={photo ? 'gb-kz-photo' : 'gb-kz-photo gb-na'}>
        {photo?.viewUrl ? <img src={photo.viewUrl} alt={`${label} photograph`} /> : null}
      </div>
    </figure>
  );
}

const DECISIONS: { value: KaizenReviewDecision; label: string }[] = [
  { value: 'APPROVED', label: 'Approve' },
  { value: 'SENT_BACK', label: 'Send back' },
  { value: 'REJECTED', label: 'Reject' },
];

/** A Coordinator's decision on a SUBMITTED Kaizen. A reason is required to send back or reject. */
function Review({ kaizen }: { kaizen: KaizenDetail }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<KaizenReviewDecision | null>(null);
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  // One Idempotency-Key per decision: a retry of the same body replays it, and a changed
  // decision or reason gets a new key (the server refuses a key reused with another body).
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const review = useMutation({
    mutationFn: () => {
      const body = { decision, comment: comment.trim() || null };
      const json = JSON.stringify(body);
      if (attempt.current?.body !== json) attempt.current = { body: json, key: crypto.randomUUID() };
      return api.post(`/kaizens/${kaizen.id}/review`, body, attempt.current.key);
    },
    onSuccess: async () => {
      attempt.current = null;
      setDecision(null);
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['kaizen', kaizen.id] });
      await queryClient.invalidateQueries({ queryKey: ['kaizens'] });
      await queryClient.invalidateQueries({ queryKey: ['kaizen-dashboard'] });
    },
  });

  if (!can('kaizen', 'review') || kaizen.status !== 'SUBMITTED') return null;
  const needsReason = decision === 'SENT_BACK' || decision === 'REJECTED';

  return (
    <div className="space-y-3 border border-edge-soft p-3">
      <p className="gb-label">Review</p>
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map((option) => (
          <Button
            key={option.value}
            variant={decision === option.value ? 'primary' : 'secondary'}
            aria-pressed={decision === option.value}
            onClick={() => {
              setDecision(option.value);
              setMissing(false);
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {decision && (
        <>
          <Field
            label={needsReason ? 'Reason' : 'Comment'}
            hint={needsReason ? 'The Zone Leader reads this on their phone.' : 'Optional.'}
            {...(missing ? { error: 'A reason is required to send back or reject a Kaizen.' } : {})}
          >
            <textarea className="gb-input" rows={3} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <ErrorNotice error={review.error} />
          <Button
            disabled={review.isPending}
            onClick={() => {
              if (needsReason && !comment.trim()) setMissing(true);
              else review.mutate();
            }}
          >
            {review.isPending ? 'Saving…' : `Confirm: ${DECISIONS.find((option) => option.value === decision)!.label}`}
          </Button>
        </>
      )}
    </div>
  );
}

/** §4.6: the Kaizen Sheet as a PDF — queued, polled until ready, then downloaded. */
function ExportButton({ kaizen }: { kaizen: KaizenDetail }) {
  const exportPdf = useMutation({
    mutationFn: async () => {
      const path = `/kaizens/${kaizen.id}/export`;
      let job = await api.post<KaizenExport>(path);
      for (let tries = 0; job.status === 'QUEUED' && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await api.get<KaizenExport>(`${path}/${job.exportId}`);
      }
      if (job.status !== 'READY' || !job.downloadUrl) throw new Error('The PDF could not be made. Try again.');
      // Fetched and saved under the sheet's own name (R-48(g)), as the 5S reports are.
      const response = await fetch(job.downloadUrl);
      if (!response.ok) throw new Error(`The PDF could not be fetched (HTTP ${response.status}).`);
      savePdf({ bytes: await response.arrayBuffer(), fileName: job.fileName, checksum: 'unchecked' });
    },
  });
  return (
    <div className="space-y-2">
      <ErrorNotice error={exportPdf.error} />
      <Button variant="secondary" disabled={exportPdf.isPending} onClick={() => exportPdf.mutate()}>
        {exportPdf.isPending ? 'Preparing the PDF…' : 'Download Kaizen Sheet (PDF)'}
      </Button>
    </div>
  );
}
