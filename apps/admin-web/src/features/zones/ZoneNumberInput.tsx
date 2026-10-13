import { useState, type ReactNode } from 'react';
import { zoneLabelParts } from '@audit5s/domain';
import { Field, Input } from '@/components/ui';

/**
 * A Zone's label (R-52) as two inputs: the number, digits only, and — only for a Unit that
 * splits its Zones into subzones (1A, 1B…) — one letter, behind a tick box. Emits the joined
 * label (`1A`), which `zoneCodeForLabel` turns into the stored code. `children` (the name
 * field) sits on the same line. The phone's `zone-number-field.tsx` at a desk.
 */
export function ZoneNumberInput({
  value,
  onChange,
  error,
  hint,
  children,
}: {
  value: string;
  onChange: (label: string) => void;
  error?: string;
  hint?: string;
  children?: ReactNode;
}) {
  const { number, subzone } = zoneLabelParts(value);
  const [hasSubzone, setHasSubzone] = useState(subzone !== '');
  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex gap-3">
        <Field label="Zone no." error={error} hint={hint}>
          <Input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            placeholder="1"
            className="w-20 gb-data"
            value={number}
            onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 3) + (hasSubzone ? subzone : ''))}
          />
        </Field>
        {hasSubzone ? (
          <Field label="Subzone">
            <Input
              placeholder="A"
              className="w-16 gb-data"
              value={subzone}
              onChange={(event) => onChange(number + event.target.value.replace(/[^a-z]/gi, '').slice(-1).toUpperCase())}
            />
          </Field>
        ) : null}
        {children ? <div className="min-w-0 flex-1">{children}</div> : null}
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={hasSubzone}
          onChange={(event) => {
            setHasSubzone(event.target.checked);
            if (!event.target.checked) onChange(number);
          }}
        />
        This Zone has subzones (1A, 1B, 1C…)
      </label>
    </div>
  );
}
