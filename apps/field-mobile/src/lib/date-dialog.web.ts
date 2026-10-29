import type { AndroidNativeProps } from '@react-native-community/datetimepicker';

// The DOM types are not in this project's lib, so the bits of `<input>` used are spelled out.
interface DateInput {
  type: string;
  value: string;
  min: string;
  max: string;
  style: { cssText: string };
  addEventListener(event: 'change' | 'blur', listener: () => void): void;
  remove(): void;
  showPicker(): void;
  focus(): void;
  click(): void;
}
const { document } = globalThis as unknown as {
  document: { createElement(tag: 'input'): DateInput; body: { appendChild(node: DateInput): void } };
};

/** `YYYY-MM-DD` of the day IST calls `date`, which is the day the app stores. */
const dayKey = (date: Date) => new Date(date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * `DateTimePickerAndroid.open` in a browser (date mode only, the one the app uses): the
 * browser's own date input, opened at once. The picked day comes back as noon IST, so
 * `istDateKey` and `endOfDay` read the day that was tapped.
 */
export const DateTimePickerAndroid = {
  open({ value, minimumDate, maximumDate, onChange }: AndroidNativeProps) {
    const input = document.createElement('input');
    input.type = 'date';
    input.value = dayKey(value);
    if (minimumDate) input.min = dayKey(minimumDate);
    if (maximumDate) input.max = dayKey(maximumDate);
    input.style.cssText = 'position:fixed;top:50%;left:50%;opacity:0;pointer-events:none';
    document.body.appendChild(input);
    const done = () => input.remove();
    input.addEventListener('change', () => {
      if (input.value) {
        const date = new Date(`${input.value}T12:00:00+05:30`);
        onChange?.({ type: 'set', nativeEvent: { timestamp: date.getTime(), utcOffset: 0 } }, date);
      }
      done();
    });
    input.addEventListener('blur', () => setTimeout(done, 1000));
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  },
  dismiss: async () => true,
};
