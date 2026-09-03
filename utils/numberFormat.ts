/**
 * Cached number formatting for the render hot paths.
 *
 * `Number.prototype.toLocaleString(locale, options)` builds a fresh
 * `Intl.NumberFormat` on every call, and constructing one is far more expensive
 * than the formatting itself. Both of the app's grouped-number call sites run
 * per frame — the time ruler formats a label for every visible tick inside the
 * spectrogram's rAF loop, and the running time readout reformats on every
 * media-clock tick — which put `toLocaleString` at 21% of all JS execution in a
 * 89s profile (see local/profile/FINDINGS.md).
 *
 * Formatters are immutable and safe to share, so one per decimal count, kept
 * for the life of the process. The locale is fixed at 'en-US' to match what the
 * call sites already asked for: these are numeric readouts a user may write
 * down or search for, so their separators must not shift with the host locale.
 */

const formatters = new Map<number, Intl.NumberFormat>();

const formatterFor = (decimals: number): Intl.NumberFormat => {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    formatters.set(decimals, f);
  }
  return f;
};

/**
 * `value` with thousands separators and exactly `decimals` fraction digits —
 * identical output to `value.toLocaleString('en-US', { min/maxFractionDigits })`,
 * without rebuilding the formatter each call.
 */
export const formatGrouped = (value: number, decimals: number = 0): string =>
  formatterFor(decimals).format(value);
