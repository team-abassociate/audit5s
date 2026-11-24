import { useEffect, useRef, useState } from 'react';
import { KAIZEN_SAVING_TYPES, type KaizenSavingCalc, type KaizenSavingLine, type KaizenSavingType } from '@audit5s/contracts';
import {
  SAVING_SECS,
  SAVING_TYPES,
  calcSavingLine,
  formatRupees,
  missingSavingInputs,
  newSavingLine,
  savingSummary,
  type SavingField,
  type SavingOption,
} from '@audit5s/domain';
import { Button, Field, Input, Select } from '@/components/ui';

/** Lines per Kaizen, as on the phone: the working stays inside the contract's cap. */
const MAX_LINES = 10;

export interface SavingCalcResult {
  annualSaving: number;
  implementationCost: number;
  savingCalc: KaizenSavingCalc;
}

/**
 * The savings calculator on the web form: the phone's (`saving-calculator.tsx`), with the
 * same domain arithmetic (`packages/domain` kaizen-savings). "Use this saving" hands the
 * form the annual saving, the cost to implement and the working to keep with the Kaizen.
 */
export function SavingCalculator({
  initial,
  onUse,
}: {
  initial: readonly KaizenSavingLine[] | null;
  onUse: (result: SavingCalcResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<KaizenSavingLine[]>(() => (initial ? [...initial] : []));
  const box = useRef<HTMLDivElement>(null);
  /** A saving was just added from the picker: its first box takes the focus, in place. */
  const added = useRef(false);
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    const editors = box.current?.querySelectorAll<HTMLElement>('[data-saving-line]');
    editors?.[editors.length - 1]
      ?.querySelector<HTMLElement>('input, select')
      ?.focus({ preventScroll: true });
  }, [lines.length]);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {initial ? 'Change the calculation' : 'Calculate the saving'}
      </Button>
    );
  }

  const summary = savingSummary(lines);
  const setValue = (index: number, values: KaizenSavingLine['values']) =>
    setLines((all) => all.map((line, i) => (i === index ? { ...line, values: { ...line.values, ...values } } : line)));

  return (
    <div ref={box} className="space-y-4 border border-rule-soft p-4">
      <p className="text-sm text-ink-2">
        Pick what the Kaizen saved and fill in the numbers. The working is kept with the Kaizen, so the reviewer can see it.
      </p>
      {lines.map((line, index) => (
        <SavingLineEditor
          key={index}
          line={line}
          onChange={(values) => setValue(index, values)}
          onRemove={() => setLines((all) => all.filter((_, i) => i !== index))}
        />
      ))}
      {lines.length < MAX_LINES ? (
        <Field label={lines.length ? 'Add another saving' : 'What did it save?'}>
          <Select
            value=""
            onChange={(event) => {
              const type = event.target.value as KaizenSavingType;
              if (!type) return;
              // The new saving goes in above this picker. Left focused, the browser holds the
              // picker still on screen (scroll anchoring), so the page jumped down past the
              // boxes just added. Released first, the page stays put and they appear in place.
              event.currentTarget.blur();
              added.current = true;
              setLines((all) => [...all, newSavingLine(type)]);
            }}
          >
            <option value="">Choose…</option>
            {KAIZEN_SAVING_TYPES.map((type) => (
              <option key={type} value={type}>
                {SAVING_TYPES[type].label}: {SAVING_TYPES[type].title}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {summary ? (
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="gb-label">Annual saving</dt>
            <dd className="gb-data text-lg font-semibold text-ink">{formatRupees(summary.annualSaving)}</dd>
          </div>
          <div>
            <dt className="gb-label">Cost to implement</dt>
            <dd className="gb-data text-lg font-semibold text-ink">{formatRupees(summary.implementationCost)}</dd>
          </div>
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!summary}
          onClick={() => {
            if (!summary) return;
            onUse({
              annualSaving: summary.annualSaving,
              implementationCost: summary.implementationCost,
              savingCalc: { lines, working: summary.working },
            });
            setOpen(false);
          }}
        >
          Use this saving
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </div>
  );
}

function SavingLineEditor({
  line,
  onChange,
  onRemove,
}: {
  line: KaizenSavingLine;
  onChange: (values: KaizenSavingLine['values']) => void;
  onRemove: () => void;
}) {
  const type = SAVING_TYPES[line.type];
  const result = calcSavingLine(line);
  const missing = result ? [] : missingSavingInputs(line);
  const value = (key: string, def: string | number = '') => String(line.values[key] ?? def);
  const pickers = new Set<string>();

  /** A time unit converts the number already typed (30 sec → 0.5 min), as the source does. */
  const changeUnit = (key: string, time: boolean | undefined, to: string) => {
    const from = value(key);
    const next: KaizenSavingLine['values'] = { [key]: to };
    if (time && from !== to) {
      for (const f of type.fields) {
        const x = Number(line.values[f.id]);
        if (f.units?.key === key && line.values[f.id] !== '' && Number.isFinite(x)) {
          next[f.id] = +((x * (SAVING_SECS[from] ?? 1)) / (SAVING_SECS[to] ?? 1)).toFixed(4);
        }
      }
    }
    onChange(next);
  };

  const choice = (label: string, opts: readonly SavingOption[], current: string, set: (v: string) => void) => (
    <Field key={label} label={label}>
      <Select value={current} onChange={(event) => set(event.target.value)}>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </Field>
  );

  const input = (f: SavingField) => {
    if (f.opts) return choice(f.label, f.opts, value(f.id, f.def), (v) => onChange({ [f.id]: v }));
    const text = f.unit === 'text';
    const unit = f.units || text || !f.unit ? '' : `, ${f.unit}`;
    const picker = f.units && !pickers.has(f.units.key) ? f.units : null;
    if (picker) pickers.add(picker.key);
    return (
      <div key={f.id} className="space-y-2">
        <Field label={f.label + unit} {...(f.sub ? { hint: f.sub } : {})}>
          <Input
            inputMode={text ? 'text' : 'decimal'}
            maxLength={text ? 300 : 16}
            value={value(f.id)}
            onChange={(event) => onChange({ [f.id]: event.target.value })}
          />
        </Field>
        {picker
          ? choice(`${f.label}: unit`, picker.opts, value(picker.key, picker.opts[0]?.[0]), (v) => changeUnit(picker.key, picker.time, v))
          : null}
      </div>
    );
  };

  return (
    <div data-saving-line className="space-y-3 border border-rule-soft p-3">
      <p className="font-bold text-ink">{type.title}</p>
      <p className="text-sm text-ink-2">{type.note}</p>
      <div className="grid gap-4 sm:grid-cols-2">{type.fields.map(input)}</div>
      {result ? (
        <div className="space-y-1 border-t border-rule-soft pt-2 text-sm">
          <p className="gb-data font-semibold text-ink">{result.headline}</p>
          {/* Red is a score colour (LEDGER.md rule 4): a warning is maroon ink, in words. */}
          {result.warn ? <p className="text-primary-ink">{result.warn}</p> : null}
          {result.working.map((step, i) => (
            <p key={i} className="gb-data text-ink-2">
              {step}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-primary-ink">Still to fill: {missing.join(', ')}</p>
      )}
      <Button type="button" variant="danger" onClick={onRemove}>
        Remove this saving
      </Button>
    </div>
  );
}
