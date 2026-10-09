import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, Text, View } from 'react-native';
import type {
  KaizenAnalysisRow,
  KaizenDashboardPeriod,
  KaizenDepartmentSeries,
  KaizenFunnel,
  KaizenKpi,
  KaizenTrendMonth,
} from '@audit5s/contracts';
import { formatKaizenRatio as ratio, formatRupees, formatYearMonth as monthLabel, textOn } from '@audit5s/domain';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import { createThemedStyles, useTheme } from '../lib/theme';
import { Card, CardHeader, Data, Figure, Hatch, Muted, Segmented } from './ui';

/**
 * Kaizen's four dashboard visuals for the phone (plans/kaizen-module.md §4.7), from plain
 * `View`s: the field app has no chart or SVG library, and adding one is a native change.
 *
 * They draw what `GET /kaizens/dashboard` sends and compute nothing but geometry; every
 * count and ratio is the server's (`packages/domain`). Green is Approved and nothing else.
 */

export function PeriodControl({ value, onChange }: { value: KaizenDashboardPeriod; onChange: (period: KaizenDashboardPeriod) => void }) {
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  return (
    <Segmented
      options={(['overall', 'year', 'month'] as const).map((period) => ({ value: period, label: t.period[period] }))}
      value={value}
      onChange={onChange}
    />
  );
}

// ------------------------------------------------------------------------- A. KPI card

export function KpiCard({ kpi, period, onPeriod }: { kpi: KaizenKpi; period: KaizenDashboardPeriod; onPeriod: (p: KaizenDashboardPeriod) => void }) {
  const styles = useStyles();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const cells: [string, string][] = [
    [t.submitted, String(kpi.submitted)],
    [t.awaitingSection, String(kpi.awaitingReview)],
    [t.status.SENT_BACK, String(kpi.sentBack)],
    [t.status.REJECTED, String(kpi.rejected)],
    [t.rejectionRatio, ratio(kpi.rejectionRatioPct)],
    [t.acceptanceRatio, ratio(kpi.acceptanceRatioPct)],
  ];
  return (
    <Card>
      <CardHeader title={t.atAGlance} />
      <PeriodControl value={period} onChange={onPeriod} />
      <View style={styles.grid}>
        {cells.map(([label, value], index) => (
          <View
            key={label}
            style={[styles.cell, index % 2 === 1 && styles.cellRight, index >= 2 && styles.cellBelow]}
            accessible
            accessibilityLabel={`${label}: ${value}`}
          >
            <Figure size={27}>{value}</Figure>
            <Text style={styles.cellLabel}>{label}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// --------------------------------------------------------------------------- B. funnel

/** A stage never narrower than this share, so a zero stage still shows its count. */
const MIN_STAGE = 0.18;

export function FunnelCard({ funnel, period, onPeriod }: { funnel: KaizenFunnel; period: KaizenDashboardPeriod; onPeriod: (p: KaizenDashboardPeriod) => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const first = funnel[0]?.count ?? 0;
  const fills = [theme.color.edgeSoft, theme.color.ink3, theme.color.okBand, theme.color.ok];
  return (
    <Card>
      <CardHeader title={t.funnelTitle} />
      <PeriodControl value={period} onChange={onPeriod} />
      <View style={styles.funnel}>
        {funnel.map((stage, index) => {
          const share = first > 0 ? Math.max(stage.count / first, MIN_STAGE) : MIN_STAGE;
          const fill = fills[index] ?? theme.color.edgeSoft;
          const ink = textOn(fill, theme.color.ink, theme.color.tile);
          return (
            // Only the count, large, sits on the fill: light mode's --ok-band holds no small text
            // at 4.5:1 in either ink or tile, so the name and share are set under it, in ink.
            <View
              key={stage.stage}
              accessible
              accessibilityLabel={`${t.funnelStage[stage.stage]}: ${stage.count}, ${t.ofSubmitted(ratio(stage.pctOfSubmitted))}`}
            >
              <AnimatedWidth share={share}>
                <View style={[styles.stage, { backgroundColor: fill }]}>
                  <Text style={[styles.stageCount, { color: ink }]}>{stage.count}</Text>
                </View>
              </AnimatedWidth>
              <Text style={styles.stageName} numberOfLines={1}>
                {t.funnelStage[stage.stage]} · <Text style={styles.stagePct}>{t.ofSubmitted(ratio(stage.pctOfSubmitted))}</Text>
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

/**
 * A centred bar whose width follows the numbers, eased when the period changes (strong
 * ease-out, 220 ms, restarted from wherever it is if changed again) and instant under
 * reduced motion. Width is not a transform, so this runs on the JS thread: four bars, once
 * per tap, which the phone does not notice.
 */
function AnimatedWidth({ share, children }: { share: number; children: React.ReactNode }) {
  const value = useRef(new Animated.Value(share)).current;
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) value.setValue(share);
      else Animated.timing(value, { toValue: share, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    });
    return () => {
      cancelled = true;
    };
  }, [share, value]);
  const width = value.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return <Animated.View style={{ width, alignSelf: 'center' }}>{children}</Animated.View>;
}

// ---------------------------------------------------------------------------- C. trend

const CHART_HEIGHT = 132;
const BAR = 16;

export function TrendCard({ trend }: { trend: readonly KaizenTrendMonth[] }) {
  const styles = useStyles();
  const theme = useTheme();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [picked, setPicked] = useState<string | null>(null);
  const max = Math.max(1, ...trend.flatMap((month) => [month.submitted, month.approved]));
  return (
    <Card>
      <View style={styles.trendTitle} accessibilityRole="header">
        <Text style={styles.titleWord}>{t.trendPrefix} </Text>
        <Text style={[styles.titleWord, { color: theme.color.ink3 }]}>{t.trendSubmission}</Text>
        <Text style={styles.titleWord}> / </Text>
        <Text style={[styles.titleWord, { color: theme.color.ok }]}>{t.trendCompletion}</Text>
        <Text style={styles.titleWord}> {t.trendSuffix}</Text>
      </View>
      <Chart max={max} picked={picked}>
        {trend.map((month) => (
          <View key={month.month} style={styles.group}>
            <View style={styles.bars}>
              <Bar
                value={month.submitted}
                max={max}
                style={{ backgroundColor: theme.color.edgeSoft, borderWidth: 1, borderColor: theme.color.ink3 }}
                label={`${t.submitted} · ${monthLabel(month.month)}`}
                onPick={setPicked}
              />
              <Bar
                value={month.approved}
                max={max}
                style={{ backgroundColor: theme.color.okBand }}
                label={`${t.approved} · ${monthLabel(month.month)}`}
                onPick={setPicked}
              />
            </View>
            <Text style={styles.axisLabel}>{monthLabel(month.month)}</Text>
          </View>
        ))}
      </Chart>
    </Card>
  );
}

// -------------------------------------------------------------------- D. top departments

export function TopDepartmentsCard({
  months,
  series,
}: {
  months: readonly string[];
  series: { submitted: readonly KaizenDepartmentSeries[]; approved: readonly KaizenDepartmentSeries[] };
}) {
  const styles = useStyles();
  const theme = useTheme();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [which, setWhich] = useState<'submitted' | 'approved'>('submitted');
  const [picked, setPicked] = useState<string | null>(null);
  const lines = series[which];
  const max = Math.max(1, ...lines.flatMap((line) => line.monthly));
  // Five series told apart without colour: an ink-scale fill, and a pattern on alternate ones.
  const fills = [theme.color.ink, theme.color.ink2, theme.color.ink3, theme.color.edgeSoft, theme.color.tape];
  const look = (index: number) => {
    const fill = fills[index] ?? theme.color.ink3;
    return index % 3 === 2
      ? { style: { backgroundColor: theme.color.tile, borderWidth: 1.5, borderColor: fill }, hatch: false }
      : { style: { backgroundColor: fill }, hatch: index % 3 === 1 };
  };
  const name = (line: KaizenDepartmentSeries) => line.label ?? t.noDepartment;

  return (
    <Card>
      <CardHeader title={t.topTitle} />
      <Segmented
        options={[
          { value: 'submitted', label: t.submitted },
          { value: 'approved', label: t.approved },
        ]}
        value={which}
        onChange={(next) => {
          setWhich(next);
          setPicked(null);
        }}
      />
      {lines.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{t.noData}</Muted>
        </View>
      ) : (
        <>
          <Chart max={max} picked={picked}>
            {months.map((month, monthIndex) => (
              <View key={month} style={styles.group}>
                <View style={styles.bars}>
                  {lines.map((line, index) => (
                    <Bar
                      key={line.key}
                      value={line.monthly[monthIndex] ?? 0}
                      max={max}
                      style={look(index).style}
                      hatch={look(index).hatch}
                      label={`${name(line)} · ${monthLabel(month)}`}
                      onPick={setPicked}
                    />
                  ))}
                </View>
                <Text style={styles.axisLabel}>{monthLabel(month)}</Text>
              </View>
            ))}
          </Chart>
          <View style={styles.legend}>
            {lines.map((line, index) => (
              <View key={line.key} style={styles.legendItem}>
                <View style={[styles.swatch, look(index).style]}>{look(index).hatch ? <Hatch /> : null}</View>
                <Text style={styles.legendText} numberOfLines={2}>
                  {name(line)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------ table

export function AnalysisTable({
  rows,
  by,
  onBy,
}: {
  rows: readonly KaizenAnalysisRow[];
  by: 'department' | 'zone';
  onBy: (by: 'department' | 'zone') => void;
}) {
  const styles = useStyles();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const columns: [string, (row: KaizenAnalysisRow) => string][] = [
    [t.total, (row) => String(row.total)],
    [t.approved, (row) => String(row.approved)],
    [t.pending, (row) => String(row.pending)],
    [t.returned, (row) => String(row.returned)],
    [t.approvedSaving, (row) => formatRupees(row.approvedSaving)],
  ];
  return (
    <Card>
      <Segmented
        options={[
          { value: 'department', label: t.department },
          { value: 'zone', label: t.zone },
        ]}
        value={by}
        onChange={onBy}
      />
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{t.noData}</Muted>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[styles.tableRow, styles.tableHead]}>
              <Text style={[styles.th, styles.firstCol]}>{by === 'zone' ? t.zone : t.department}</Text>
              {columns.map(([label]) => (
                <Text key={label} style={[styles.th, styles.numCol]}>
                  {label}
                </Text>
              ))}
            </View>
            {rows.map((row) => (
              <View key={row.key} style={styles.tableRow}>
                <Text style={[styles.td, styles.firstCol]} numberOfLines={2}>
                  {row.zoneCode ? `${row.zoneCode} · ` : ''}
                  {row.label ?? t.noDepartment}
                </Text>
                {columns.map(([label, value]) => (
                  <Text key={label} style={[styles.tdNum, styles.numCol]}>
                    {value(row)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- shared

/**
 * The plot: a 0 / mid / max axis of integers and the groups, scrolling sideways **inside**
 * the card when six months do not fit (GEMBA §6), so the page never does. A tapped bar's
 * exact count shows in the tile above (there is no hover on a phone).
 */
function Chart({ max, picked, children }: { max: number; picked: string | null; children: React.ReactNode }) {
  const styles = useStyles();
  const ticks = [...new Set([max, Math.round(max / 2), 0])];
  return (
    <>
      <View style={styles.pickedTile}>{picked ? <Data>{picked}</Data> : null}</View>
      <View style={styles.chart}>
        <View style={styles.axis}>
          {ticks.map((tick) => (
            <Text key={tick} style={styles.tick}>
              {tick}
            </Text>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.plot}>
          {children}
        </ScrollView>
      </View>
    </>
  );
}

function Bar({
  value,
  max,
  style,
  hatch,
  label,
  onPick,
}: {
  value: number;
  max: number;
  style: object;
  hatch?: boolean;
  label: string;
  onPick: (text: string) => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={() => onPick(`${label}: ${value}`)}
      hitSlop={{ top: CHART_HEIGHT, bottom: 8 }}
      style={styles.barSlot}
    >
      <View style={[styles.bar, style, { height: value === 0 ? 0 : Math.max(2, (value / max) * CHART_HEIGHT) }]}>
        {hatch && value > 0 ? <Hatch /> : null}
      </View>
    </Pressable>
  );
}

const useStyles = createThemedStyles((theme) => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: theme.space.md },
  cell: { width: '50%', paddingVertical: theme.space.sm, paddingRight: theme.space.sm },
  cellRight: { borderLeftWidth: 1, borderLeftColor: theme.color.edgeSoft, paddingLeft: theme.space.md },
  cellBelow: { borderTopWidth: 1, borderTopColor: theme.color.edgeSoft },
  cellLabel: {
    fontFamily: theme.family.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.ink2,
  },
  funnel: { marginTop: theme.space.md, gap: 3 },
  stage: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 6 },
  stageCount: { fontFamily: theme.family.black, fontSize: 20, fontVariant: ['tabular-nums'], letterSpacing: -0.8 },
  stageName: { fontFamily: theme.family.medium, fontSize: 12, color: theme.color.ink, textAlign: 'center', marginTop: 2, marginBottom: 4 },
  stagePct: { fontFamily: theme.family.mono, fontSize: 11, color: theme.color.ink2 },
  trendTitle: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: theme.space.sm },
  titleWord: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    textTransform: 'uppercase',
    color: theme.color.ink,
  },
  pickedTile: { minHeight: 22, marginTop: theme.space.sm, alignItems: 'flex-start' },
  chart: { flexDirection: 'row', height: CHART_HEIGHT + 22 },
  axis: { height: CHART_HEIGHT, justifyContent: 'space-between', paddingRight: 6 },
  tick: { fontFamily: theme.family.mono, fontSize: 10, color: theme.color.ink3, textAlign: 'right' },
  plot: { alignItems: 'flex-start', gap: theme.space.md, borderLeftWidth: 1, borderLeftColor: theme.color.edgeSoft, paddingLeft: 6 },
  group: { alignItems: 'center' },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: CHART_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.ink3,
  },
  barSlot: { justifyContent: 'flex-end', height: CHART_HEIGHT },
  bar: { width: BAR, overflow: 'hidden' },
  axisLabel: { fontFamily: theme.family.mono, fontSize: 10, color: theme.color.ink3, marginTop: 4 },
  legend: { marginTop: theme.space.md, gap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  swatch: { width: 16, height: 16, overflow: 'hidden' },
  legendText: { flex: 1, fontFamily: theme.family.regular, fontSize: theme.font.sm, color: theme.color.ink },
  empty: { paddingVertical: theme.space.lg },
  tableRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.color.edgeSoft, paddingVertical: 8 },
  tableHead: { borderTopWidth: 0, marginTop: theme.space.md },
  th: { fontFamily: theme.family.mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.color.ink2 },
  td: { fontFamily: theme.family.medium, fontSize: theme.font.sm, color: theme.color.ink },
  tdNum: { fontFamily: theme.family.mono, fontSize: theme.font.sm, color: theme.color.ink, textAlign: 'right', fontVariant: ['tabular-nums'] },
  firstCol: { width: 150, paddingRight: theme.space.sm },
  numCol: { width: 78, textAlign: 'right' },
}));
