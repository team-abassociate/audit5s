import { Children, memo, useEffect, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
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
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SSection } from '@audit5s/contracts';
import logo from '../../assets/audit5s-logo.png';
import { S_SECTION_LABELS, S_SECTION_SHORT_LABELS, formatScore } from '@audit5s/domain';
import {
  bandFill,
  bandInk,
  bandOf,
  createThemedStyles,
  iosHardShadow,
  useTheme,
  type Band,
} from '../lib/theme';
import { EASE_OUT, fadeIn, transition } from '../lib/motion';

/** A Material icon's name: the one icon set, so a symbol means the same thing on every screen. */
export type IconName = ComponentProps<typeof MaterialIcons>['name'];

/** An icon in the text's colour, sized to sit beside a label. Decorative: the label says it. */
export function Icon({ name, color, size = 18 }: { name: IconName; color: string; size?: number }) {
  return <MaterialIcons name={name} size={size} color={color} accessibilityElementsHidden importantForAccessibility="no" />;
}

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
export function Magnet({
  offset = 3,
  pressed,
  style,
  children,
}: {
  offset?: number;
  /** The face is pressed onto it: the shadow goes, which is all a press is under reduced motion. */
  pressed?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[{ position: 'relative', marginRight: offset, marginBottom: offset }, style]}>
      {Platform.OS === 'android' ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: offset,
            left: offset,
            right: -offset,
            bottom: -offset,
            backgroundColor: theme.color.hard,
            opacity: pressed ? 0 : 1,
            transitionProperty: 'opacity',
            ...transition,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The house press (GEMBA §2.2, plan M1): on press-in the face sinks onto its shadow and the
 * shadow goes, over the one 143 ms ease-out, and comes back the same way. Held in state, not
 * Pressable's style function, so the change can be a transition; two renders a press, none a
 * frame. Under reduced motion the face stays put and only the shadow goes (plan 002).
 */
function usePress(offset: number, rest: Pick<PressableProps, 'onPressIn' | 'onPressOut'>, held = false) {
  const [down, setPressed] = useState(false);
  const pressed = down || held;
  const travel = useReducedMotion() ? 0 : offset;
  return {
    pressed,
    sink: {
      transform: [{ translateX: pressed ? travel : 0 }, { translateY: pressed ? travel : 0 }],
      ...(pressed ? { shadowOpacity: 0 } : null),
      transitionProperty: 'transform',
      ...transition,
    },
    handlers: {
      onPressIn: (event: Parameters<NonNullable<PressableProps['onPressIn']>>[0]) => {
        setPressed(true);
        rest.onPressIn?.(event);
      },
      onPressOut: (event: Parameters<NonNullable<PressableProps['onPressOut']>>[0]) => {
        setPressed(false);
        rest.onPressOut?.(event);
      },
    },
  };
}

/**
 * Plays once as it mounts: back to its own colour after it was lit, the admin web's arrival
 * highlight (plans/005-arrival-transition.md, plan M4): held 0.9 s, then 0.7 s ease-out. A
 * colour change, so it plays under reduced motion too.
 */
function useArrival(arrived: boolean | undefined) {
  const [lit, setLit] = useState(Boolean(arrived));
  useEffect(() => {
    if (!lit) return;
    const frame = requestAnimationFrame(() => setLit(false));
    return () => cancelAnimationFrame(frame);
    // Once, on mount: the first frame draws it lit, the next starts the fade.
  }, []);
  return lit;
}

/**
 * A magnet on the board (`gb-panel`). A tappable card presses onto its shadow like
 * `gb-tile--interactive:active`. `rail` is the 4px severity edge of `gb-row-*`.
 */
export function Card({
  children,
  style,
  rail,
  arrived,
  ...rest
}: Omit<PressableProps, 'style'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  rail?: Band;
  /** The one just sent from this phone: lit in the selection colour, then fading to its own. */
  arrived?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const tappable = rest.onPress !== undefined;
  const press = usePress(theme.press, rest);
  const lit = useArrival(arrived);
  return (
    <Magnet style={styles.cardGap} pressed={tappable && press.pressed}>
      {/* Only a Link card is one a11y element; otherwise TalkBack must reach the inputs inside. */}
      <AnimatedPressable
        accessible={tappable}
        {...rest}
        // Only a tappable card presses: a form step must not re-render under a passing scroll.
        {...(tappable ? press.handlers : null)}
        style={[
          styles.card,
          rail && rail !== 'none' && { borderLeftWidth: 4, borderLeftColor: bandFill(rail, theme.color) },
          style,
          tappable && press.sink,
          arrived && {
            backgroundColor: lit ? theme.color.accentSoft : theme.color.tile,
            transitionProperty: ['transform', 'backgroundColor'],
            transitionDuration: [theme.motion, 700],
            transitionDelay: [0, lit ? 0 : 900],
          },
        ]}
      >
        {children}
      </AnimatedPressable>
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
  icon,
  children,
}: {
  /** `accent`: waiting on someone, a colour no decision uses. */
  tone?: Band | 'muted' | 'accent';
  icon?: IconName;
  children: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const color = tone === 'muted' ? theme.color.ink2 : tone === 'accent' ? theme.color.accent : bandInk(tone, theme.color);
  return (
    <View style={[styles.chip, icon && styles.chipWithIcon, { borderColor: color }]}>
      {icon ? <Icon name={icon} color={color} size={13} /> : null}
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
              row.pct === null ? 'not applicable' : `${formatScore(row.pct)} percent`
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
              {row.pct === null ? 'N/A' : formatScore(row.pct)}
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
  variant = 'default',
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
  /** `danger`: the crit rule and ink, for the header action that ends something. */
  variant?: 'default' | 'danger';
  disabled?: boolean;
}) {
  const styles = useStyles();
  const danger = variant === 'danger';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        styles.headerAction,
        danger && styles.headerActionDanger,
        disabled && styles.headerActionDisabled,
        pressed && styles.headerActionPressed,
      ]}
    >
      <Text style={[styles.headerActionText, danger && styles.headerActionDangerText, disabled && styles.headerActionTextDisabled]}>{title}</Text>
    </Pressable>
  );
}

/**
 * The bottom-anchored action area: the primary action within thumb reach, ruled off in ink
 * and clear of the gesture bar. It bleeds to the screen edges through `Screen`'s padding.
 */
/**
 * The bar of actions pinned to the bottom edge.
 *
 * `row` lays them side by side in equal shares, for the case where the choices are
 * alternatives rather than a primary action with an escape hatch below it — three ways to
 * leave an audit, say. Stacked is still the default: a single full-width button is easier
 * to hit with a gloved thumb, and two stacked read in priority order.
 */
export function ActionBar({ children, row }: { children: ReactNode; row?: boolean }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.actionBar, row && styles.actionBarRow, { paddingBottom: 14 + insets.bottom }]}>
      {row
        ? Children.map(children, (child) =>
            child === null || child === undefined || child === false ? null : (
              <View style={styles.actionBarCell}>{child}</View>
            ),
          )
        : children}
    </View>
  );
}

export function Field({
  label,
  error,
  hint,
  containerStyle,
  revealable,
  inputRef,
  ...rest
}: TextInputProps & {
  /** The text box itself — `useRequiredFields().input(key)` scrolls to it and focuses it. */
  inputRef?: Ref<TextInput>;
  label: string;
  error?: string;
  hint?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** A password: typed hidden, with a Show / Hide toggle so the person can check it. */
  revealable?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const input = (
    <TextInput
      ref={inputRef}
      accessibilityLabel={label}
      style={[
        styles.input,
        rest.multiline && styles.inputMultiline,
        revealable && styles.inputRevealable,
        error ? styles.inputError : null,
      ]}
      placeholderTextColor={theme.color.ink3}
      {...rest}
      {...(revealable ? { secureTextEntry: !revealed } : {})}
      onFocus={(event) => {
        setFocused(true);
        rest.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        rest.onBlur?.(event);
      }}
    />
  );
  return (
    <View style={[styles.field, containerStyle]}>
      <Label>{label}</Label>
      {/* The web's `:focus-visible` ring: 2px accent, offset 2px — the accent's one job. */}
      <View style={[styles.focusRing, focused && { borderColor: theme.color.accent }]}>
        {revealable ? (
          <View style={styles.inputRow}>
            {input}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
              onPress={() => setRevealed((shown) => !shown)}
              style={({ pressed }) => [styles.reveal, pressed && styles.revealPressed]}
            >
              <Text style={styles.revealText}>{revealed ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
        ) : (
          input
        )}
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
  icon,
  tone,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** The symbol software puts on this action (delete, download, camera…), before the word. */
  icon?: IconName;
  /** An outline in a decision's colour: Approve `ok`, Send back `warn`, Reject `crit`. */
  tone?: Exclude<Band, 'none'>;
  /** 26dp tall on screen, still a 48dp target (hitSlop), for a bar that must stay slim. */
  compact?: boolean;
  /** `danger` is an outline, never a red fill: red is a score band (non-negotiable 6). */
  variant?: 'primary' | 'secondary' | 'danger';
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const isPrimary = variant === 'primary' && !tone;
  const inert = busy || disabled;
  const ink = tone
    ? bandInk(tone, theme.color)
    : variant === 'danger'
      ? theme.color.crit
      : isPrimary
        ? theme.color.board
        : theme.color.ink;
  // A busy button stays down, so the press reads as taken while it works.
  const press = usePress(2, {}, Boolean(busy));
  return (
    <Magnet offset={2} pressed={press.pressed} style={inert && styles.inert}>
      <AnimatedPressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled: Boolean(inert), busy: Boolean(busy) }}
        disabled={inert}
        onPress={onPress}
        hitSlop={compact ? 11 : undefined}
        {...press.handlers}
        style={[
          styles.button,
          compact && styles.buttonCompact,
          isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
          (variant === 'danger' || tone) && { borderColor: ink },
          press.sink,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={ink} />
        ) : (
          <View style={styles.buttonRow}>
            {icon ? <Icon name={icon} color={ink} size={compact ? 14 : 18} /> : null}
            <Text
              style={[
                isPrimary ? styles.buttonPrimaryText : styles.buttonSecondaryText,
                { color: ink },
                compact && styles.buttonCompactText,
              ]}
            >
              {title}
            </Text>
          </View>
        )}
      </AnimatedPressable>
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
  arriving,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * It says what was just done (a submit, a review): it drops 6px into place as it appears
   * (plan M3), not from the edge. Under reduced motion it only fades in.
   */
  arriving?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const tappable = rest.onPress !== undefined;
  const press = usePress(theme.press, rest);
  const reduced = useReducedMotion();
  const slip = (
    <Magnet style={styles.cardGap} pressed={tappable && press.pressed}>
      <AnimatedPressable
        accessible={tappable}
        {...rest}
        {...(tappable ? press.handlers : null)}
        style={[styles.slip, style, tappable && press.sink]}
      >
        <Text style={styles.slipTitle}>{title}</Text>
        {children}
      </AnimatedPressable>
    </Magnet>
  );
  if (!arriving) return slip;
  // Reduced motion keeps the fade (opacity is not movement) and drops the drop.
  const entering = reduced
    ? fadeIn
    : FadeInDown.withInitialValues({ transform: [{ translateY: -6 }] }).duration(theme.motion).easing(EASE_OUT);
  return <Animated.View entering={entering}>{slip}</Animated.View>;
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
            source={logo}
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

/**
 * One of a few views of the same list. Selected is ink, like a pressed button.
 *
 * `scrolls`: each option is as wide as its word (at least 88) and the strip scrolls sideways
 * when they do not fit, rather than truncating a label to "वापस …".
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  scrolls,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  scrolls?: boolean;
}) {
  const styles = useStyles();
  const strip = (
    <View style={[styles.segmented, scrolls && styles.segmentedScrolls]} accessibilityRole="tablist">
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              scrolls && styles.segmentScrolls,
              index > 0 && styles.segmentDivider,
              selected && styles.segmentSelected,
            ]}
          >
            <Text numberOfLines={1} style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  if (!scrolls) return strip;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmentScroller}>
      {strip}
    </ScrollView>
  );
}

/** A vertical radio list — the picker for Units and people. Selection is the accent's job. */
export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  empty,
}: {
  /** `tone` and `icon`: a choice that is a decision wears that decision's colour and symbol. */
  options: ReadonlyArray<{ value: T; label: string; detail?: string | null; tone?: Exclude<Band, 'none'>; icon?: IconName }>;
  value: T | null;
  onChange: (value: T) => void;
  empty?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
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
            style={[
              styles.choice,
              selected && styles.choiceSelected,
              option.tone && { borderLeftWidth: 6, borderLeftColor: bandFill(option.tone, theme.color) },
              // The band's fill at ~15% over the tile: the chosen decision tinted in its own colour.
              option.tone && selected && { borderColor: bandInk(option.tone, theme.color), backgroundColor: `${bandFill(option.tone, theme.color)}26` },
            ]}
          >
            <View style={styles.buttonRow}>
              {option.icon ? <Icon name={option.icon} color={option.tone ? bandInk(option.tone, theme.color) : theme.color.ink} /> : null}
              <Text style={[styles.choiceLabel, styles.flexText, option.tone && { color: bandInk(option.tone, theme.color) }]}>{option.label}</Text>
            </View>
            {option.detail ? <Text style={styles.choiceDetail}>{option.detail}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A dropdown: one closed field showing the current pick, opening a sheet of the options from
 * the bottom edge. For a pick from a list that can grow (a Unit's people), where `ChoiceList`
 * would push the rest of the form off the screen.
 */
export function SelectField<T extends string>({
  label,
  options,
  value,
  onChange,
  placeholder = 'Choose…',
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; detail?: string | null }>;
  value: T | null;
  onChange: (value: T) => void;
  placeholder?: string;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? placeholder}. Tap to change.`}
        onPress={() => setOpen(true)}
        style={[styles.input, styles.select]}
      >
        <View style={styles.selectText}>
          <Text style={current ? styles.choiceLabel : styles.selectPlaceholder} numberOfLines={1}>
            {current?.label ?? placeholder}
          </Text>
          {current?.detail ? <Text style={styles.choiceDetail}>{current.detail}</Text> : null}
        </View>
        <Text style={styles.selectCaret}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom, maxHeight: height * 0.75 }]}>
          <Text style={styles.h2} accessibilityRole="header">
            {label}
          </Text>
          <ScrollView contentContainerStyle={styles.selectList} accessibilityRole="radiogroup">
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    setOpen(false);
                    onChange(option.value);
                  }}
                  style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, pressed && styles.pressed]}
                >
                  <Text style={styles.choiceLabel}>{option.label}</Text>
                  {option.detail ? <Text style={styles.choiceDetail}>{option.detail}</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Button title="Cancel" variant="secondary" onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </View>
  );
}

/**
 * One tickable row — `ChoiceList`'s look, for a choice of several. A ticked row carries the
 * accent rail and a ✓; an unticked one stays plain, so the count is read at a glance.
 */
export function CheckRow({
  label,
  detail,
  value,
  checked,
  onChange,
}: {
  label: string;
  detail?: string | null;
  /** Right-aligned figure, e.g. the Zone's score. */
  value?: string | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => onChange(!checked)}
      style={[styles.choice, checked && styles.choiceSelected]}
    >
      <View style={styles.checkHead}>
        <Text style={[styles.choiceLabel, styles.checkLabel]}>
          {checked ? '✓ ' : ''}
          {label}
        </Text>
        {value ? <Text style={styles.choiceDetail}>{value}</Text> : null}
      </View>
      {detail ? <Text style={styles.choiceDetail}>{detail}</Text> : null}
    </Pressable>
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
 * A blocking notice (GEMBA-BOARD.md §6 "Dialog"): 2px ink border, 6px hard shadow, and the
 * crit rail of `gb-notice` because it reports something the auditor must fix before going
 * on. One action, right-aligned — it is a stop sign, not a question.
 */
export function NoticeDialog({
  visible,
  title,
  message,
  actionLabel,
  onClose,
}: {
  visible: boolean;
  title: string;
  message: string;
  actionLabel: string;
  onClose: () => void;
}) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel={actionLabel} />
      <View style={styles.dialogShell} pointerEvents="box-none">
        <Magnet offset={6}>
          <View style={styles.dialog} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={styles.h2} accessibilityRole="header">
              {title}
            </Text>
            <Text style={styles.noticeText}>{message}</Text>
            <View style={styles.dialogActions}>
              <Button title={actionLabel} onPress={onClose} />
            </View>
          </View>
        </Magnet>
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
  keepLabel = 'Keep',
  icon,
  onConfirm,
}: {
  title: string;
  icon?: IconName;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  /** The way out, in the screen's language. */
  keepLabel?: string;
  /** A small outline trigger for a row in a list, so a list of people is not a wall of red. */
  compact?: boolean;
  onConfirm: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  if (!asking && compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={question}
        onPress={() => setAsking(true)}
        hitSlop={6}
        style={({ pressed }) => [styles.headerAction, styles.compactDanger, icon && styles.buttonRow, pressed && styles.headerActionPressed]}
      >
        {icon ? <Icon name={icon} color={theme.color.crit} size={14} /> : null}
        <Text style={[styles.headerActionText, styles.compactDangerText]}>{title}</Text>
      </Pressable>
    );
  }
  if (!asking) return <Button title={title} variant="danger" icon={icon} onPress={() => setAsking(true)} />;
  return (
    <View style={styles.confirm} accessibilityLiveRegion="polite">
      <Text style={styles.noticeText}>{question}</Text>
      <View style={styles.confirmRow}>
        <View style={styles.confirmItem}>
          <Button title={keepLabel} variant="secondary" onPress={() => setAsking(false)} />
        </View>
        <View style={styles.confirmItem}>
          <Button title={confirmLabel} variant="danger" icon={icon} busy={busy} onPress={onConfirm} />
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
  chipWithIcon: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
  headerActionDanger: { borderColor: theme.color.crit },
  headerActionDangerText: { color: theme.color.crit },
  headerActionDisabled: { borderColor: theme.color.edgeSoft },
  headerActionTextDisabled: { color: theme.color.ink3 },
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
  actionBarRow: { flexDirection: 'row', alignItems: 'stretch', gap: theme.space.xs },
  // Equal shares, and `minWidth: 0` so a long label wraps inside its cell instead of
  // pushing the others off the screen.
  actionBarCell: { flex: 1, minWidth: 0 },
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
  inputRow: { flexDirection: 'row' },
  inputRevealable: { flex: 1, borderRightWidth: 0 },
  // The Show / Hide toggle: a square tile sharing the input's ink edge.
  reveal: {
    minWidth: 64,
    minHeight: 48,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
  },
  revealPressed: { backgroundColor: theme.color.tile2 },
  revealText: {
    fontFamily: theme.family.bold,
    fontSize: 10.5,
    letterSpacing: 0.95,
    textTransform: 'uppercase',
    color: theme.color.ink,
  },
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
  buttonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  buttonPrimaryText: { color: theme.color.board, fontFamily: theme.family.medium, fontSize: theme.font.sm },
  buttonSecondaryText: { color: theme.color.ink, fontFamily: theme.family.medium, fontSize: theme.font.sm },
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
  segmentScroller: { flexGrow: 1 },
  segmentedScrolls: { flexGrow: 1 },
  segmentScrolls: { flex: 0, flexGrow: 1, flexBasis: 'auto', minWidth: 88, paddingHorizontal: 12 },
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
  flexText: { flex: 1 },
  choiceLabel: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  choiceDetail: { fontFamily: theme.family.regular, fontSize: 12.5, color: theme.color.ink2, marginTop: 2 },
  select: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  selectText: { flex: 1, minWidth: 0 },
  selectPlaceholder: { fontFamily: theme.family.regular, fontSize: theme.font.base, color: theme.color.ink3 },
  selectCaret: { fontFamily: theme.family.bold, fontSize: theme.font.base, color: theme.color.ink2 },
  selectList: { gap: theme.space.sm },
  checkHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm },
  checkLabel: { flexShrink: 1 },
  dialogShell: { flex: 1, justifyContent: 'center', padding: theme.space.md },
  dialog: {
    backgroundColor: theme.color.tile,
    borderWidth: 2,
    borderColor: theme.color.edge,
    borderLeftWidth: 6,
    borderLeftColor: theme.color.critBand,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: theme.space.sm },
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
