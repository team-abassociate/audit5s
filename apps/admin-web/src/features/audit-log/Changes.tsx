import { formatDateTime, RESPONSE_TOKENS } from '@audit5s/domain';
import { humanize } from '@/lib/labels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TOKEN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$|^[A-Z]{2,}$/;

/** `zoneLeaderId` → "Zone leader", `checksumSha256` → "Checksum sha256". */
export function fieldLabel(key: string): string {
  return humanize(key.replace(/Id$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/** One stored value in words: dates in the portal's format, marks by their name, no enum tokens. */
export function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString('en-IN');
  if (typeof value === 'string') {
    if (ISO.test(value)) return formatDateTime(value);
    if (RESPONSE_TOKENS[value]) return RESPONSE_TOKENS[value].label;
    if (TOKEN.test(value)) return humanize(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(readable).join(', ');
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A row id says nothing to a person; the raw JSON under "Technical details" keeps it. */
const isIdOnly = (values: unknown[]) =>
  values.every((value) => value === null || value === undefined || (typeof value === 'string' && UUID.test(value)));

/**
 * What a record holds, or what changed in it, as a list of "Field: old → new" (L2, S4x)
 * instead of a JSON diff. Keys come from `after` (or `before` when nothing replaced it).
 * `changedOnly` drops fields whose value did not move — an edit that saved seven fields to
 * change one shows the one.
 */
export function Changes({
  before,
  after,
  changedOnly = false,
}: {
  before: unknown;
  after: unknown;
  changedOnly?: boolean;
}) {
  const was = asRecord(before);
  const now = asRecord(after);
  const main = now ?? was;
  if (!main) {
    return <p className="text-sm text-ink-3">{readable(after ?? before)}</p>;
  }

  const rows = Object.keys(main)
    .filter((key) => key !== 'id' && !isIdOnly([was?.[key], now?.[key]]))
    .map((key) => {
      const old = was && now && key in was ? was[key] : undefined;
      const value = now ? now[key] : was![key];
      const moved = old !== undefined && JSON.stringify(old) !== JSON.stringify(value);
      return { key, old, value, moved };
    })
    .filter((row) => !changedOnly || row.moved || !was || !now);

  if (rows.length === 0) return <p className="text-sm text-ink-3">No field changed.</p>;

  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-ink-3">{fieldLabel(row.key)}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
            {row.moved ? (
              <>
                <span className="text-ink-3">{readable(row.old)}</span>
                <span aria-hidden> → </span>
                <span className="sr-only"> changed to </span>
                {readable(row.value)}
              </>
            ) : (
              readable(row.value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
