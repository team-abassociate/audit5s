import { memo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SSection } from '@audit5s/contracts';
import { S_SECTION_LABELS, S_SECTION_SHORT_LABELS } from '@audit5s/domain';
import {
  bandFill,
  bandInk,
  bandOf,
  createThemedStyles,
  iosHardShadow,
  useTheme,
  type Band,
} from '../lib/theme';

/**
 * The shared controls, built from the Gemba Board primitives
 * (`docs/design/GEMBA-BOARD.md` §6), named after their admin-web counterparts in
 * `apps/admin-web/src/components/ui.tsx` and `styles.css` so the two apps read as one system.
 *
 * No hex literal, no radius, no blurred shadow: a card is a magnet, a button is a tile you
 * can press, status is a band, a rail, a chip or a hatch — never colour alone.
 */

const GRID = 28;

/** The dry-erase ground: a faint 28px rule behind every screen, as on the web body. */
const BoardGrid = memo(function BoardGrid() {
  const { width, height } = useWindowDimensions();
  const theme = useTheme();
  const line = { position: 'absolute', backgroundColor: theme.color.boardLine } as const;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: Math.ceil(height / GRID) }, (_, i) => (
        <View key={`h${i}`} style={[line, { left: 0, right: 0, top: (i + 1) * GRID, height: 1 }]} />
      ))}
      {Array.from({ length: Math.ceil(width / GRID) }, (_, i) => (
        <View key={`v${i}`} style={[line, { top: 0, bottom: 0, left: (i + 1) * GRID, width: 1 }]} />
      ))}
    </View>
  );
});

/**
 * A screen on the board. The 2px ink rule at the top is the header's bottom edge (the web
 * topbar's `border-bottom`), drawn here because a native header cannot carry a hard border.
 * `bare` drops it for screens with no header above them.
 */
export function Screen({
  children,
  style,
  bare,
  ...rest
}: ViewProps & { children: ReactNode; bare?: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.screen, !bare && styles.screenRuled, style]} {...rest}>
      <BoardGrid />
      {children}
    </View>
  );
}

/** The hard offset shadow. Android's `elevation` is always blurred, so it is a second view. */
function Magnet({
  offset = 3,
  style,
  children,
}: {
  offset?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[{ position: 'relative', marginRight: offset, marginBottom: offset }, style]}>
      {Platform.OS === 'android' ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: offset,
            left: offset,
            right: -offset,
            bottom: -offset,
            backgroundColor: theme.color.hard,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

/**
 * A magnet on the board (`gb-panel`). A tappable card presses onto its shadow like
 * `gb-tile--interactive:active`. `rail` is the 4px severity edge of `gb-row-*`.
 */
export function Card({
  children,
  style,
  rail,
  ...rest
}: Omit<PressableProps, 'style'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  rail?: Band;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const tappable = rest.onPress !== undefined;
  return (
    <Magnet style={styles.cardGap}>
      {/* Only a Link card is one a11y element; otherwise TalkBack must reach the inputs inside. */}
      <Pressable
        accessible={tappable}
        style={({ pressed }) => [
          styles.card,
          rail && rail !== 'none' && { borderLeftWidth: 4, borderLeftColor: bandFill(rail, theme.color) },
          tappable && pressed && styles.pressed,
          style,
        ]}
        {...rest}
      >
        {children}
      </Pressable>
    </Magnet>
  );
}

/** `gb-panel-head`: the title block across the top of a card, ruled off in 2px ink. */
export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string | null;
  action?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.cardHead}>
      <View style={styles.headText}>
        <Text style={styles.h2}>{title}</Text>
        {description ? <Text style={styles.headDescription}>{description}</Text> : null}
      </View>
      {action}
    </View>
  );
}

/** `gb-head`: a section heading with its 2px ink underline, content 14px below. */
export function SectionHead({
  title,
  description,
  action,
}: {
  title: string;
  description?: string | null;
  action?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.sectionHead} accessibilityRole="header">
      <View style={styles.headText}>
        <Text style={styles.heading}>{title}</Text>
        {description ? <Text style={styles.headDescription}>{description}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.muted}>{children}</Text>;
}

export function Label({ children, fit }: { children: ReactNode; fit?: boolean }) {
  const styles = useStyles();
  return (
    <Text style={styles.label} {...(fit ? { numberOfLines: 1, adjustsFontSizeToFit: true } : {})}>
      {children}
    </Text>
  );
}

/** Small data — timestamps, counts, codes. DM Mono, tabular. Never a display figure. */
export function Data({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.data}>{children}</Text>;
}

/** A display figure: Archivo 900, tight, tabular (non-negotiable 5). */
export function Figure({
  children,
  band,
  size = 29,
}: {
  children: ReactNode;
  band?: Band;
  size?: number;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      style={[
        styles.figure,
        { fontSize: size, lineHeight: Math.round(size * 1.12), letterSpacing: -0.04 * size },
        band && { color: bandInk(band, theme.color) },
      ]}
    >
      {children}
    </Text>
  );
}

/** `gb-chip`: an outlined status word. The colour is the outline and the text, never a fill. */
export function Chip({
  tone = 'muted',
  children,
}: {
  tone?: Band | 'muted';
  children: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const color = tone === 'muted' ? theme.color.ink2 : bandInk(tone, theme.color);
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{children}</Text>
    </View>
  );
}

/** `gb-tape`: a masking-tape strip. Section markers only. */
export function Tape({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.tape}>
      <Text style={styles.tapeText}>{children}</Text>
    </View>
  );
}

/** `gb-band`: the 6px status stripe under a value. `none` is the dashed stripe. */
export function StatusBand({ band }: { band: Band }) {
  const styles = useStyles();
  const theme = useTheme();
  if (band === 'none') {
    return (
      <View style={[styles.band, styles.bandDashed]}>
        {Array.from({ length: 40 }, (_, i) => (
          <View key={i} style={[styles.bandDash, { backgroundColor: theme.color.edgeSoft }]} />
        ))}
      </View>
    );
  }
  return <View style={[styles.band, { backgroundColor: bandFill(band, theme.color) }]} />;
}

/** `gb-na`: a 45° hatch fills the space a value would take. Never a colour, never a zero. */
export function Hatch() {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      {Array.from({ length: 60 }, (_, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            top: -40,
            bottom: -40,
            left: i * 11 - 22,
            width: 4,
            backgroundColor: theme.color.edgeSoft,
            transform: [{ rotate: '45deg' }],
          }}
        />
      ))}
    </View>
  );
}

export interface SectionRow {
  section: SSection;
  pct: number | null;
  raw?: number;
  max?: number;
}

/**
 * `gb-srow`: the five S rows of the detail panel — `[label | track | value]` with the
 * 0/25/50/75/100 tick row beneath. An all-NA section is hatched and reads `N/A`.
 */
export function SectionRows({ rows, marks }: { rows: readonly SectionRow[]; marks?: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.srows}>
      {rows.map((row) => {
        const band = bandOf(row.pct);
        const name = S_SECTION_LABELS[row.section].match(/\((.+)\)/)?.[1] ?? '';
        return (
          <View
            key={row.section}
            accessible
            accessibilityLabel={`${S_SECTION_LABELS[row.section]}: ${
              row.pct === null ? 'not applicable' : `${row.pct.toFixed(1)} percent`
            }`}
            style={styles.srow}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.srowLabel}>
              {S_SECTION_SHORT_LABELS[row.section]} {name}
            </Text>
            <View style={styles.track}>
              {row.pct === null ? (
                <Hatch />
              ) : (
                <View
                  style={[
                    styles.trackFill,
                    { width: `${Math.min(100, row.pct)}%`, backgroundColor: bandFill(band, theme.color) },
                  ]}
                />
              )}
            </View>
            <Text style={[styles.srowValue, row.pct === null && styles.srowNa]}>
              {row.pct === null ? 'N/A' : row.pct.toFixed(1)}
            </Text>
            {marks ? (
              <Text style={styles.srowMarks}>
                {row.raw ?? 0}/{row.max ?? 0}
              </Text>
            ) : null}
          </View>
        );
      })}
      <View style={styles.srow} importantForAccessibility="no-hide-descendants">
        <View style={styles.srowLabel} />
        <View style={styles.ticks}>
          {['0', '25', '50', '75', '100'].map((tick) => (
            <Text key={tick} style={styles.tick}>
              {tick}
            </Text>
          ))}
        </View>
        <View style={styles.srowValue} />
        {marks ? <View style={styles.srowMarks} /> : null}
      </View>
    </View>
  );
}

/** `gb-stats3`: figures side by side in one ruled block. */
export function StatGrid({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: string; band?: Band }>;
}) {
  const styles = useStyles();
  return (
    <View style={styles.stats}>
      {items.map((item) => (
        <View key={item.label} style={styles.stat} accessible accessibilityLabel={`${item.label}: ${item.value}`}>
          <Label>{item.label}</Label>
          <Figure size={27} band={item.band}>
            {item.value}
          </Figure>
        </View>
      ))}
    </View>
  );
}

/** The navigator title, set like the web topbar's h1: heavy and uppercase. */
export function HeaderTitle({ children }: { children: string }) {
  const styles = useStyles();
  return (
    <Text numberOfLines={1} style={styles.headerTitle}>
      {children}
    </Text>
  );
}

/** A text action for the header's right side, sized to the 48dp target. */
export function HeaderAction({
  title,
  onPress,
  accessibilityLabel,
  testID,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.headerAction, pressed && styles.headerActionPressed]}
    >
      <Text style={styles.headerActionText}>{title}</Text>
    </Pressable>
  );
}

/**
 * The bottom-anchored action area: the primary action within thumb reach, ruled off in ink
 * and clear of the gesture bar. It bleeds to the screen edges through `Screen`'s padding.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return <View style={[styles.actionBar, { paddingBottom: 14 + insets.bottom }]}>{children}</View>;
}

export function Field({
  label,
  error,
  hint,
  containerStyle,
  ...rest
}: TextInputProps & {
  label: string;
  error?: string;
  hint?: string;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, containerStyle]}>
      <Label>{label}</Label>
      {/* The web's `:focus-visible` ring: 2px accent, offset 2px — the accent's one job. */}
      <View style={[styles.focusRing, focused && { borderColor: theme.color.accent }]}>
        <TextInput
          accessibilityLabel={label}
          style={[styles.input, rest.multiline && styles.inputMultiline, error ? styles.inputError : null]}
          placeholderTextColor={theme.color.ink3}
          {...rest}
          onFocus={(event) => {
            setFocused(true);
            rest.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            rest.onBlur?.(event);
          }}
        />
      </View>
      {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  busy,
  disabled,
  variant = 'primary',
  accessibilityLabel,
  testID,
  compact,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** 26dp tall on screen, still a 48dp target (hitSlop), for a bar that must stay slim. */
  compact?: boolean;
  /** `danger` is an outline, never a red fill: red is a score band (non-negotiable 6). */
  variant?: 'primary' | 'secondary' | 'danger';
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  const inert = busy || disabled;
  return (
    <Magnet offset={2} style={inert && styles.inert}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled: Boolean(inert), busy: Boolean(busy) }}
        disabled={inert}
        onPress={onPress}
        hitSlop={compact ? 11 : undefined}
        style={({ pressed }) => [
          styles.button,
          compact && styles.buttonCompact,
          isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
          variant === 'danger' && styles.buttonDanger,
          (pressed || busy) && styles.buttonPressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={isPrimary ? theme.color.board : theme.color.ink} />
        ) : (
          <Text
            style={[
              isPrimary ? styles.buttonPrimaryText : styles.buttonSecondaryText,
              variant === 'danger' && styles.buttonDangerText,
              compact && styles.buttonCompactText,
            ]}
          >
            {title}
          </Text>
        )}
      </Pressable>
    </Magnet>
  );
}

/**
 * `gb-notice`: a problem rendered where the user is looking — a crit rail, not a yellow
 * slip. The slip is reserved for the one thing someone must act on.
 */
export function ErrorBanner({ message }: { message: string | null }) {
  const styles = useStyles();
  if (!message) return null;
  return (
    <View style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

/** `gb-slip`: the yellow note. At most one per screen, and only when someone must act. */
export function Slip({
  title,
  children,
  style,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const tappable = rest.onPress !== undefined;
  return (
    <Magnet style={styles.cardGap}>
      <Pressable
        accessible={tappable}
        style={({ pressed }) => [styles.slip, tappable && pressed && styles.pressed, style]}
        {...rest}
      >
        <Text style={styles.slipTitle}>{title}</Text>
        {children}
      </Pressable>
    </Magnet>
  );
}

export function SlipText({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.slipText}>{children}</Text>;
}

/** `gb-tile--pending`: nothing here yet is a dashed tile with a way forward, not a void. */
export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Muted>{detail}</Muted> : null}
    </View>
  );
}

/** `gb-gate-card`: the signed-out screens are one tile on the board, with a 6px shadow. */
export function GateCard({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <Magnet offset={6} style={styles.gateShell}>
      <View style={styles.gate}>
        <View style={styles.brand}>
          <Image
            source={require('../../assets/audit5s-logo.png')}
            style={styles.brandLogo}
            accessibilityIgnoresInvertColors
            accessibilityLabel="audit5s"
          />
          <View>
            <Text style={styles.brandName}>audit5s</Text>
            <Text style={styles.brandLine}>5S field audit</Text>
          </View>
        </View>
        {children}
      </View>
    </Magnet>
  );
}

/** A ledger row: label on the left, mono value on the right, a hairline between rows. */
export function LedgerRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.ledger, last && styles.ledgerLast]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.ledgerLabel}>{label}</Text>
      <Text style={styles.ledgerValue}>{value}</Text>
    </View>
  );
}

/** Filters a list already on screen. No label above it: the placeholder says what it searches. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.search}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.color.ink3}
        accessibilityLabel={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        style={styles.searchInput}
      />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChangeText('')} style={styles.searchClear}>
          <Text style={styles.searchClearText}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One of a few views of the same list. Selected is ink, like a pressed button. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, index > 0 && styles.segmentDivider, selected && styles.segmentSelected]}
          >
            <Text numberOfLines={1} style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A vertical radio list — the picker for Units and people. Selection is the accent's job. */
export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  empty,
}: {
  options: ReadonlyArray<{ value: T; label: string; detail?: string | null }>;
  value: T | null;
  onChange: (value: T) => void;
  empty?: string;
}) {
  const styles = useStyles();
  if (options.length === 0) return empty ? <Muted>{empty}</Muted> : null;
  return (
    <View style={styles.choices} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={[styles.choice, selected && styles.choiceSelected]}
          >
            <Text style={styles.choiceLabel}>{option.label}</Text>
            {option.detail ? <Text style={styles.choiceDetail}>{option.detail}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The + menu: a ruled sheet from the bottom edge, within thumb reach. */
export function ActionSheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  actions: ReadonlyArray<{ label: string; detail?: string; onPress: () => void }>;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom }]}>
        <Text style={styles.h2} accessibilityRole="header">
          {title}
        </Text>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              action.onPress();
            }}
            style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
          >
            <Text style={styles.sheetLabel}>{action.label}</Text>
            {action.detail ? <Text style={styles.choiceDetail}>{action.detail}</Text> : null}
          </Pressable>
        ))}
        <Button title="Cancel" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

/**
 * A destructive action that asks first, in place — never `Alert`/`confirm()` (GEMBA-BOARD.md
 * §6 "Dialog"). The question says what will and will not happen.
 */
export function ConfirmAction({
  title,
  question,
  confirmLabel,
  busy,
  compact,
  onConfirm,
}: {
  title: string;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  /** A small outline trigger for a row in a list, so a list of people is not a wall of red. */
  compact?: boolean;
  onConfirm: () => void;
}) {
  const styles = useStyles();
  const [asking, setAsking] = useState(false);
  if (!asking && compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={question}
        onPress={() => setAsking(true)}
        hitSlop={6}
        style={({ pressed }) => [styles.headerAction, styles.compactDanger, pressed && styles.headerActionPressed]}
      >
        <Text style={[styles.headerActionText, styles.compactDangerText]}>{title}</Text>
      </Pressable>
    );
  }
  if (!asking) return <Button title={title} variant="danger" onPress={() => setAsking(true)} />;
  return (
    <View style={styles.confirm} accessibilityLiveRegion="polite">
      <Text style={styles.noticeText}>{question}</Text>
      <View style={styles.confirmRow}>
        <View style={styles.confirmItem}>
          <Button title="Keep" variant="secondary" onPress={() => setAsking(false)} />
        </View>
        <View style={styles.confirmItem}>
          <Button title={confirmLabel} variant="danger" busy={busy} onPress={onConfirm} />
        </View>
      </View>
    </View>
  );
}

/** `gb-av`: initials on an ink block. */
export function Avatar({ name, size = 44 }: { name: string | undefined; size?: number }) {
  const styles = useStyles();
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.length === 0 ? '··' : ((parts[0]?.[0] ?? '') + (parts.at(-1)?.[0] ?? '')).toUpperCase();
  return (
    <View style={[styles.avatar, { width: size, height: size }]} importantForAccessibility="no-hide-descendants">
      <Text style={[styles.avatarText, { fontSize: Math.round(size / 3) }]}>{initials}</Text>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  screen: { flex: 1, backgroundColor: theme.color.board, padding: theme.space.md },
  screenRuled: { borderTopWidth: 2, borderTopColor: theme.color.edge },
  cardGap: { marginBottom: theme.space.sm + 3 },
  card: {
    backgroundColor: theme.color.tile,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
    ...iosHardShadow(theme.color.hard),
  },
  pressed: { transform: [{ translateX: 3 }, { translateY: 3 }], shadowOpacity: 0 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.md,
    marginHorizontal: -theme.space.md,
    marginTop: -theme.space.md,
    marginBottom: theme.space.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.edge,
  },
  headText: { flex: 1 },
  headDescription: {
    fontFamily: theme.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.color.ink2,
    marginTop: 3,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space.md,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.edge,
    paddingBottom: theme.space.sm,
    marginBottom: theme.space.md,
  },
  heading: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.heading,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.38,
  },
  h2: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
  },
  muted: { fontFamily: theme.family.regular, fontSize: theme.font.sm, lineHeight: 20, color: theme.color.ink2 },
  label: {
    fontFamily: theme.family.medium,
    fontSize: 10.5,
    color: theme.color.ink3,
    marginBottom: theme.space.xs,
    textTransform: 'uppercase',
    letterSpacing: 1.37,
  },
  data: {
    fontFamily: theme.family.mono,
    fontSize: 12.5,
    color: theme.color.ink2,
    fontVariant: ['tabular-nums'],
  },
  figure: {
    fontFamily: theme.family.black,
    color: theme.color.ink,
    fontVariant: ['tabular-nums'],
  },
  chip: { borderWidth: 1.5, paddingHorizontal: 7, paddingVertical: 2, alignSelf: 'flex-start' },
  chipText: {
    fontFamily: theme.family.bold,
    fontSize: 10.5,
    letterSpacing: 0.95,
    textTransform: 'uppercase',
  },
  tape: { backgroundColor: theme.color.tape, paddingHorizontal: 12, paddingVertical: 4, alignSelf: 'flex-start' },
  tapeText: {
    fontFamily: theme.family.bold,
    fontSize: 10.5,
    letterSpacing: 1.47,
    textTransform: 'uppercase',
    color: theme.color.tapeInk,
  },
  band: { height: 6, alignSelf: 'stretch' },
  bandDashed: { flexDirection: 'row', overflow: 'hidden', gap: 6 },
  bandDash: { width: 6, height: 6 },
  srows: { gap: 9 },
  srow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  srowLabel: {
    width: 104,
    fontFamily: theme.family.medium,
    fontSize: 11,
    color: theme.color.ink2,
    textTransform: 'uppercase',
  },
  track: {
    flex: 1,
    height: 12,
    backgroundColor: theme.color.tile2,
    borderWidth: 1,
    borderColor: theme.color.edgeSoft,
    overflow: 'hidden',
  },
  trackFill: { height: '100%' },
  srowValue: {
    width: 46,
    textAlign: 'right',
    fontFamily: theme.family.monoMedium,
    fontSize: 12.5,
    color: theme.color.ink,
    fontVariant: ['tabular-nums'],
  },
  srowNa: { fontSize: 11, color: theme.color.ink3 },
  srowMarks: {
    width: 44,
    textAlign: 'right',
    fontFamily: theme.family.mono,
    fontSize: 11.5,
    color: theme.color.ink3,
    fontVariant: ['tabular-nums'],
  },
  ticks: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: -5 },
  tick: { fontFamily: theme.family.mono, fontSize: 9.5, color: theme.color.ink3 },
  stats: {
    flexDirection: 'row',
    gap: 1.5,
    backgroundColor: theme.color.edge,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
  },
  stat: { flex: 1, backgroundColor: theme.color.tile2, paddingVertical: 10, paddingHorizontal: 12 },
  headerTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.16,
  },
  headerAction: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
  },
  headerActionPressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  headerActionText: { fontFamily: theme.family.medium, fontSize: theme.font.sm, color: theme.color.ink },
  compactDanger: { borderColor: theme.color.crit, alignSelf: 'flex-start' },
  compactDangerText: { color: theme.color.crit },
  actionBar: {
    marginHorizontal: -theme.space.md,
    marginBottom: -theme.space.md,
    paddingHorizontal: theme.space.md,
    paddingTop: theme.space.md,
    gap: theme.space.sm,
    backgroundColor: theme.color.tile2,
    borderTopWidth: 2,
    borderTopColor: theme.color.edge,
  },
  field: { marginBottom: theme.space.md },
  focusRing: { margin: -4, padding: 2, borderWidth: 2, borderColor: 'transparent' },
  input: {
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm + 2,
    minHeight: 48,
    fontFamily: theme.family.regular,
    fontSize: theme.font.base,
    color: theme.color.ink,
    backgroundColor: theme.color.tile2,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  inputError: { borderColor: theme.color.critBand },
  hint: { fontFamily: theme.family.regular, fontSize: 12.5, lineHeight: 18, color: theme.color.ink2, marginTop: theme.space.xs },
  error: {
    fontFamily: theme.family.regular,
    color: theme.color.crit,
    fontSize: 12.5,
    marginTop: 5,
    borderLeftWidth: 3,
    borderLeftColor: theme.color.critBand,
    paddingLeft: 7,
  },
  inert: { opacity: 0.55 },
  button: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    ...iosHardShadow(theme.color.hard, 2),
  },
  buttonCompact: { minHeight: 26, paddingVertical: 2, paddingHorizontal: 10 },
  buttonCompactText: { fontSize: 12 },
  buttonPrimary: { backgroundColor: theme.color.ink },
  buttonSecondary: { backgroundColor: theme.color.tile },
  buttonDanger: { borderColor: theme.color.crit },
  buttonPressed: { transform: [{ translateX: 2 }, { translateY: 2 }], shadowOpacity: 0 },
  buttonPrimaryText: { color: theme.color.board, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  buttonSecondaryText: { color: theme.color.ink, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  buttonDangerText: { color: theme.color.crit },
  notice: {
    backgroundColor: theme.color.tile2,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    borderLeftWidth: 4,
    borderLeftColor: theme.color.critBand,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: theme.space.md,
  },
  noticeText: { color: theme.color.ink, fontFamily: theme.family.regular, fontSize: theme.font.sm, lineHeight: 19 },
  slip: {
    backgroundColor: theme.color.slip,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    paddingVertical: 12,
    paddingHorizontal: theme.space.md,
    gap: 6,
    ...iosHardShadow(theme.color.hard),
  },
  slipTitle: {
    fontFamily: theme.family.bold,
    fontSize: 10.5,
    letterSpacing: 1.47,
    textTransform: 'uppercase',
    color: theme.color.slipInk,
  },
  slipText: { fontFamily: theme.family.regular, fontSize: theme.font.sm, lineHeight: 18, color: theme.color.slipInk },
  empty: {
    backgroundColor: theme.color.tile2,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    padding: theme.space.md,
    gap: theme.space.xs,
  },
  emptyTitle: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink, textTransform: 'uppercase' },
  gateShell: { alignSelf: 'center', width: '100%', maxWidth: 400 },
  gate: {
    backgroundColor: theme.color.tile,
    borderWidth: 2,
    borderColor: theme.color.edge,
    paddingTop: 20,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.lg,
    ...iosHardShadow(theme.color.hard, 6),
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: theme.space.lg },
  brandLogo: { width: 42, height: 42 },
  brandName: {
    fontFamily: theme.family.black,
    fontSize: 24,
    lineHeight: 26,
    letterSpacing: -0.48,
    textTransform: 'uppercase',
    color: theme.color.ink,
  },
  brandLine: {
    fontFamily: theme.family.medium,
    fontSize: 11,
    letterSpacing: 1.43,
    textTransform: 'uppercase',
    color: theme.color.ink3,
    marginTop: 3,
  },
  ledger: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    gap: theme.space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.edgeSoft,
  },
  ledgerLast: { borderBottomWidth: 0, paddingBottom: 0 },
  ledgerLabel: {
    fontFamily: theme.family.medium,
    fontSize: 10.5,
    color: theme.color.ink3,
    textTransform: 'uppercase',
    letterSpacing: 1.37,
  },
  ledgerValue: {
    fontFamily: theme.family.mono,
    fontSize: theme.font.sm,
    color: theme.color.ink,
    flexShrink: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    marginBottom: theme.space.md,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: theme.space.md,
    fontFamily: theme.family.regular,
    fontSize: theme.font.base,
    color: theme.color.ink,
  },
  searchClear: { minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.space.md },
  searchClearText: { fontFamily: theme.family.medium, fontSize: theme.font.sm, color: theme.color.ink2 },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    marginBottom: theme.space.md,
  },
  segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentDivider: { borderLeftWidth: 1.5, borderLeftColor: theme.color.edge },
  segmentSelected: { backgroundColor: theme.color.ink },
  segmentText: { fontFamily: theme.family.medium, fontSize: 12.5, color: theme.color.ink2 },
  segmentTextSelected: { color: theme.color.board },
  choices: { gap: theme.space.sm, marginBottom: theme.space.md },
  choice: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    paddingVertical: 10,
    paddingHorizontal: theme.space.md,
  },
  choiceSelected: { borderColor: theme.color.accent, borderLeftWidth: 6, backgroundColor: theme.color.accentSoft },
  choiceLabel: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  choiceDetail: { fontFamily: theme.family.regular, fontSize: 12.5, color: theme.color.ink2, marginTop: 2 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.hard },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.tile,
    borderTopWidth: 2,
    borderTopColor: theme.color.edge,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  sheetRow: {
    minHeight: 52,
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    paddingVertical: 8,
    paddingHorizontal: theme.space.md,
  },
  sheetLabel: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  confirm: {
    backgroundColor: theme.color.tile2,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    borderLeftWidth: 4,
    borderLeftColor: theme.color.critBand,
    padding: 12,
    gap: theme.space.sm,
  },
  confirmRow: { flexDirection: 'row', gap: theme.space.sm },
  confirmItem: { flex: 1 },
  avatar: {
    width: 44,
    height: 44,
    backgroundColor: theme.color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontFamily: theme.family.bold, fontSize: 15, color: theme.color.board, letterSpacing: 0.3 },
}));
