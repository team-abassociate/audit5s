import { useState } from 'react';
import { Text, View } from 'react-native';
import { KAIZEN_SAVING_TYPES, type KaizenSavingCalc, type KaizenSavingLine } from '@audit5s/contracts';
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
import type { KaizenStrings } from '../lib/kaizen-strings';
import { createThemedStyles } from '../lib/theme';
import { Button, Field, Label, Muted, Segmented, SelectField } from './ui';

/** Lines per Kaizen: enough for any sheet, and the working stays inside the contract's cap. */
const MAX_LINES = 10;

export interface SavingCalcResult {
  annualSaving: number;
  implementationCost: number;
  savingCalc: KaizenSavingCalc;
}

/**
 * The savings calculator in the Benefits step (owner, 2026-11-15): the Kaizen Sheet Maker's
 * saving types and formulas (`packages/domain` kaizen-savings), one line per saving. "Use"
 * hands the form the annual saving, the cost to implement and the working to keep with the
 * Kaizen. The arithmetic is the domain's; this only edits the inputs.
 */
export function SavingCalculator({
  initial,
  t,
  onUse,
}: {
  initial: readonly KaizenSavingLine[] | null;
  t: KaizenStrings['calc'];
  onUse: (result: SavingCalcResult) => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<KaizenSavingLine[]>(() => (initial ? [...initial] : []));

  if (!open) {
    return <Button variant="secondary" icon="calculate" title={initial ? t.edit : t.open} onPress={() => setOpen(true)} testID="kaizen-calc-open" />;
  }

  const summary = savingSummary(lines);
  const setValue = (index: number, values: KaizenSavingLine['values']) =>
    setLines((all) => all.map((line, i) => (i === index ? { ...line, values: { ...line.values, ...values } } : line)));

  return (
    <View style={styles.calc}>
      <Muted>{t.intro}</Muted>
      {lines.map((line, index) => (
        <SavingLineEditor
          key={index}
          line={line}
          t={t}
          onChange={(values) => setValue(index, values)}
          onRemove={() => setLines((all) => all.filter((_, i) => i !== index))}
        />
      ))}
      {lines.length < MAX_LINES ? (
        <SelectField
          label={lines.length ? t.add : t.type}
          options={KAIZEN_SAVING_TYPES.map((type) => ({ value: type, label: SAVING_TYPES[type].label, detail: SAVING_TYPES[type].title }))}
          value={null}
          onChange={(type) => setLines((all) => [...all, newSavingLine(type)])}
        />
      ) : null}
      {summary ? (
        <View style={styles.totals}>
          <View style={styles.total}>
            <Label>{t.total}</Label>
            <Text style={styles.figure}>{formatRupees(summary.annualSaving)}</Text>
          </View>
          <View style={styles.total}>
            <Label>{t.cost}</Label>
            <Text style={styles.figure}>{formatRupees(summary.implementationCost)}</Text>
          </View>
        </View>
      ) : null}
      <Button
        title={t.use}
        disabled={!summary}
        testID="kaizen-calc-use"
        onPress={() => {
          if (!summary) return;
          onUse({
            annualSaving: summary.annualSaving,
            implementationCost: summary.implementationCost,
            savingCalc: { lines, working: summary.working },
          });
          setOpen(false);
        }}
      />
      <Button variant="secondary" title={t.close} onPress={() => setOpen(false)} />
    </View>
  );
}

function SavingLineEditor({
  line,
  t,
  onChange,
  onRemove,
}: {
  line: KaizenSavingLine;
  t: KaizenStrings['calc'];
  onChange: (values: KaizenSavingLine['values']) => void;
  onRemove: () => void;
}) {
  const styles = useStyles();
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

  const choice = (label: string, opts: readonly SavingOption[], current: string, set: (v: string) => void) => {
    const options = opts.map(([v, l]) => ({ value: v, label: l }));
    return opts.length <= 3 ? (
      <View key={label} style={styles.choice}>
        <Label>{label}</Label>
        <Segmented options={options} value={current} onChange={set} />
      </View>
    ) : (
      <SelectField key={label} label={label} options={options} value={current} onChange={set} />
    );
  };

  const input = (f: SavingField) => {
    if (f.opts) return choice(f.label, f.opts, value(f.id, f.def), (v) => onChange({ [f.id]: v }));
    const text = f.unit === 'text';
    const unit = f.units || text || !f.unit ? '' : `, ${f.unit}`;
    const picker = f.units && !pickers.has(f.units.key) ? f.units : null;
    if (picker) pickers.add(picker.key);
    return (
      <View key={f.id}>
        <Field
          label={f.label + unit}
          value={value(f.id)}
          keyboardType={text ? 'default' : 'decimal-pad'}
          maxLength={text ? 300 : 16}
          {...(f.sub ? { hint: f.sub } : {})}
          onChangeText={(v) => onChange({ [f.id]: v })}
        />
        {picker
          ? choice(`${f.label}: unit`, picker.opts, value(picker.key, picker.opts[0]?.[0]), (v) => changeUnit(picker.key, picker.time, v))
          : null}
      </View>
    );
  };

  return (
    <View style={styles.line}>
      <Text style={styles.title}>{type.title}</Text>
      <Muted>{type.note}</Muted>
      {type.fields.map(input)}
      {result ? (
        <View style={styles.result}>
          <Text style={styles.headline}>{result.headline}</Text>
          {result.warn ? <Text style={styles.warn}>{result.warn}</Text> : null}
          {result.working.map((step, i) => (
            <Text key={i} style={styles.step}>
              {step}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={styles.warn}>{`${t.missing} ${missing.join(', ')}`}</Text>
      )}
      <Button variant="danger" compact title={t.remove} onPress={onRemove} />
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  calc: { gap: theme.space.md },
  line: {
    gap: theme.space.sm,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.color.rule,
    borderRadius: theme.radius.panel,
    backgroundColor: theme.color.surface,
  },
  choice: { gap: theme.space.xs },
  title: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink },
  result: { gap: theme.space.xs, paddingTop: theme.space.sm, borderTopWidth: 1, borderTopColor: theme.color.ruleSoft },
  headline: { fontFamily: theme.family.semibold, fontSize: theme.font.base, color: theme.color.ink, fontVariant: ['tabular-nums'] },
  step: { fontFamily: theme.family.regular, fontSize: theme.font.sm, color: theme.color.ink2, fontVariant: ['tabular-nums'] },
  // Red is a score colour (LEDGER.md rule 4): a warning is maroon ink, in words.
  warn: { fontFamily: theme.family.medium, fontSize: theme.font.sm, color: theme.color.primaryInk },
  totals: { flexDirection: 'row', gap: theme.space.md },
  total: {
    flex: 1,
    gap: theme.space.xs,
    padding: theme.space.md,
    borderRadius: theme.radius.panel,
    backgroundColor: theme.color.secondarySoft,
  },
  figure: {
    fontFamily: theme.family.semibold,
    fontSize: theme.font.heading,
    letterSpacing: -0.6,
    color: theme.color.onSecondarySoft,
    fontVariant: ['tabular-nums'],
  },
}));
