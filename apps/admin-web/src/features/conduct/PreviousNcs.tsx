import { useQuery } from '@tanstack/react-query';
import type { PreviousNonconformities, PreviousNonconformity } from '@audit5s/contracts';
import { formatDate, formatDateTime } from '@audit5s/domain';
import { ErrorNotice, Spinner } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * R-79: the Zone's last finished audit's NCs — raised, closed, still open — for whoever is
 * about to audit it, each with its before photo and, once closed, its after photo.
 */
export function PreviousNcs({ zoneId }: { zoneId: string }) {
  const ncs = useQuery({
    queryKey: ['previous-ncs', zoneId],
    queryFn: () => api.get<PreviousNonconformities>(`/zones/${zoneId}/previous-nonconformities`),
  });
  if (ncs.isPending) return <Spinner label="Loading the earlier NCs…" />;
  if (ncs.error) return <ErrorNotice error={ncs.error} />;
  const data = ncs.data;
  if (!data.auditId) return <p className="text-sm text-ink-2">Earlier NCs: none — first audit of this Zone.</p>;

  return (
    <details className="rounded-control border border-rule">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        Earlier NCs: {data.raised} raised · {data.closed} closed · {data.open} open
        <span className="font-normal text-ink-2"> (last audit {data.auditDate ? formatDate(data.auditDate) : ''})</span>
      </summary>
      <ul className="space-y-3 px-3 pb-3">
        {data.items.map((item) => (
          <PreviousNc key={item.id} item={item} />
        ))}
      </ul>
    </details>
  );
}

function PreviousNc({ item }: { item: PreviousNonconformity }) {
  const closed = item.status === 'VERIFIED';
  return (
    <li className="space-y-1 border-t border-rule pt-3">
      <p className="text-sm">
        {item.questionNo ? `Q${item.questionNo}. ` : ''}
        {item.text}
      </p>
      <p className="text-xs text-ink-2">
        {closed
          ? `Closed${item.closedByName ? ` by ${item.closedByName}` : ''}${item.closedAt ? `, ${formatDateTime(item.closedAt)}` : ''}`
          : 'Open'}
      </p>
      <div className="flex gap-3">
        <Photo label="Before" url={item.beforePhotoUrl} />
        {closed ? <Photo label="After" url={item.afterPhotoUrl} /> : null}
      </div>
    </li>
  );
}

/** Opens full size in a new tab; the link is short-lived, like every photo link here. */
function Photo({ label, url }: { label: string; url: string | null }) {
  if (!url) return <p className="text-xs text-ink-2">{label}: no photo</p>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block w-32 space-y-1">
      <img src={url} alt={`${label} photo`} className="aspect-square w-full rounded-control object-cover" />
      <span className="text-xs text-ink-2">{label}</span>
    </a>
  );
}
