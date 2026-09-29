import { useCallback, useRef, useState } from 'react';
import type { TextInput, View } from 'react-native';

/** Room left above a revealed field, so its label is on screen and not under the header. */
const REVEAL_MARGIN = 24;
/** A focus straight after a scroll lands before the scroll does; the keyboard then fights it. */
const FOCUS_DELAY_MS = 300;

type Measurable = Pick<View, 'measureLayout'>;
/**
 * Either scroller a form lives in — a ScrollView, or a FlatList of any item type. Both
 * have a scroll responder, which is the ScrollView that actually scrolls.
 */
interface Scroller {
  getScrollResponder(): unknown;
}

/** What `reveal` needs from the ScrollView: its content node, and a way to scroll. */
interface Scrollable {
  getInnerViewRef(): Parameters<Measurable['measureLayout']>[0] | null;
  scrollTo(options: { y: number; animated: boolean }): void;
}

function scrollViewOf(node: Scroller | null): Scrollable | null {
  if (!node) return null;
  // A FlatList's scroll responder is the ScrollView it renders; a ScrollView's is itself.
  // `getInnerViewRef` is in the runtime and the generated types, not the legacy .d.ts.
  return node.getScrollResponder() as unknown as Scrollable | null;
}

/**
 * Required fields, the same way on every form in the app.
 *
 * A submit button stays pressable. Pressing it with something missing marks every missing
 * field in red, scrolls the **first** one into view and, when it is a text box, puts the
 * cursor in it — so the person sees at once what is left, rather than a greyed-out button
 * that does nothing and says nothing.
 *
 *     const required = useRequiredFields<'name' | 'unit'>();
 *     <ScrollView ref={required.scroll}>
 *       <Field inputRef={required.input('name')} error={required.error('name', 'Enter the name', name !== '')} … />
 *       <View ref={required.anchor('unit')} collapsable={false}>…</View>
 *     </ScrollView>
 *     onPress={() => required.check([['name', name.trim() !== ''], ['unit', unitId !== null]]) && save()}
 *
 * `check` lists fields in screen order, top to bottom: the first missing one is the one shown.
 */
export function useRequiredFields<K extends string>() {
  const scroller = useRef<Scroller | null>(null);
  /** Pass as `ref` to the form's ScrollView or FlatList. */
  const scroll = useCallback((node: Scroller | null) => {
    scroller.current = node;
  }, []);
  const anchors = useRef(new Map<K, Measurable>());
  const inputs = useRef(new Map<K, TextInput>());
  const [missing, setMissing] = useState<ReadonlySet<K>>(() => new Set());

  const remember = useCallback(
    <T>(map: Map<K, T>, key: K) =>
      (node: T | null) => {
        if (node) map.set(key, node);
        else map.delete(key);
      },
    [],
  );

  /** For a text box: it is scrolled to and focused. Pass to `Field`'s `inputRef`. */
  const input = useCallback((key: K) => remember(inputs.current, key), [remember]);
  /** For anything else — a picker, a photo — wrap it in a `View` with `collapsable={false}`. */
  const anchor = useCallback((key: K) => remember(anchors.current, key), [remember]);

  const reveal = useCallback((key: K) => {
    const target = anchors.current.get(key) ?? inputs.current.get(key);
    const view = scrollViewOf(scroller.current);
    const content = view?.getInnerViewRef?.();
    if (target && view && content) {
      // Measured against the scroll content, not the viewport, so the current scroll
      // position does not matter.
      target.measureLayout(
        content,
        (_x, y) => view.scrollTo({ y: Math.max(0, y - REVEAL_MARGIN), animated: true }),
        () => undefined,
      );
    }
    const field = inputs.current.get(key);
    if (field) setTimeout(() => field.focus(), FOCUS_DELAY_MS);
  }, []);

  /**
   * `true` when every listed field is present. Otherwise marks the missing ones, shows the
   * first, and returns `false` — so a submit reads `check([...]) && submit()`.
   */
  const check = useCallback(
    (fields: ReadonlyArray<readonly [K, boolean]>): boolean => {
      const empty = fields.filter(([, present]) => !present).map(([key]) => key);
      setMissing(new Set(empty));
      if (empty.length === 0) return true;
      reveal(empty[0]!);
      return false;
    },
    [reveal],
  );

  /**
   * The message while `key` is marked missing and still empty, else `undefined` — `Field`'s
   * `error` prop. `present` clears it the moment the person fills the field in.
   */
  const error = useCallback(
    (key: K, message: string, present: boolean): string | undefined =>
      missing.has(key) && !present ? message : undefined,
    [missing],
  );

  /** The same test as `error`, for a picker or photo that shows its own red note. */
  const flagged = useCallback(
    (key: K, present: boolean): boolean => missing.has(key) && !present,
    [missing],
  );

  return { scroll, input, anchor, check, reveal, error, flagged };
}
