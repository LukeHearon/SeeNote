// Filename timestamp parsing.
//
// Field recordings are usually named after the moment the recorder started
// (e.g. "260731_0456.mp3"). A project can declare that naming scheme as a
// pattern — the same kind of code FileSync uses — and SeeNote then knows the
// wall-clock start time of every track whose name matches, which is what lets
// the time displays switch from elapsed seconds to real datetimes.
//
// Tokens (all fixed width, which is what makes parsing unambiguous):
//   YYYY  4-digit year
//   YY    2-digit year (00–69 → 2000s, 70–99 → 1900s)
//   MM    month — OR minute, if an HH token appeared earlier in the pattern.
//         That's the rule that makes "YYMMDD_HHMM" read the way a human reads
//         it: date first, then time. Use `mm` when you want to be explicit.
//   DD    day of month
//   HH    hour, 24-hour
//   mm    minute (always; never ambiguous)
//   ss    second   (SS is accepted as a synonym)
// Everything else in the pattern is a literal character.

/**
 * A fixed, arbitrary moment shared by the settings previews that illustrate a
 * timestamp style — the filename-pattern preview and the datetime-display-format
 * preview both show this same instant. Its parts are all distinct and
 * unambiguous (month 7 vs day 31, hour 16 vs minute 56), so a mistyped pattern
 * is visible in the preview.
 */
export const FILENAME_PREVIEW_DATE = new Date(2026, 6, 31, 16, 56, 12);

export type FilenameTimeField = 'year4' | 'year2' | 'month' | 'day' | 'hour' | 'minute' | 'second';

const TOKEN_RE = /YYYY|YY|MM|DD|HH|mm|ss|SS/;

const FIELD_WIDTH: Record<FilenameTimeField, number> = {
  year4: 4, year2: 2, month: 2, day: 2, hour: 2, minute: 2, second: 2,
};

interface PatternPart {
  token: FilenameTimeField | null;
  /** Literal text when `token` is null. */
  literal: string;
}

/**
 * Split `pattern` into tokens and literals, resolving the MM month/minute
 * ambiguity by position (minute once an HH has been seen). Exported for the
 * settings preview, which needs to know whether a pattern has any tokens at
 * all.
 */
export function parsePattern(pattern: string): PatternPart[] {
  const parts: PatternPart[] = [];
  let rest = pattern;
  let sawHour = false;
  let literal = '';

  const flushLiteral = () => {
    if (literal) { parts.push({ token: null, literal }); literal = ''; }
  };

  while (rest.length > 0) {
    const m = TOKEN_RE.exec(rest);
    if (!m || m.index !== 0) {
      literal += rest[0];
      rest = rest.slice(1);
      continue;
    }
    const raw = m[0];
    let token: FilenameTimeField;
    switch (raw) {
      case 'YYYY': token = 'year4'; break;
      case 'YY': token = 'year2'; break;
      case 'MM': token = sawHour ? 'minute' : 'month'; break;
      case 'DD': token = 'day'; break;
      case 'HH': token = 'hour'; sawHour = true; break;
      case 'mm': token = 'minute'; break;
      default: token = 'second'; break; // ss / SS
    }
    flushLiteral();
    parts.push({ token, literal: raw });
    rest = rest.slice(raw.length);
  }
  flushLiteral();
  return parts;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `pattern` carries enough tokens to pin down a calendar date
 * (year + month + day). Time-of-day tokens are optional and default to
 * midnight; without a date there is nothing to anchor to.
 */
export function isUsableFilenameTimePattern(pattern: string): boolean {
  const fields = new Set(parsePattern(pattern).map(p => p.token));
  return (fields.has('year4') || fields.has('year2')) && fields.has('month') && fields.has('day');
}

/**
 * Find `pattern` anywhere in `filename` and return the wall-clock time it
 * encodes, as a local-time Date. Returns null when the name doesn't match, the
 * pattern can't pin down a date, or the fields name a day that doesn't exist
 * (e.g. "260230"). Match is unanchored, so surrounding text — a site prefix, a
 * "_part2" suffix, the extension — is fine.
 */
export function parseFilenameTime(filename: string, pattern: string): Date | null {
  if (!isUsableFilenameTimePattern(pattern)) return null;

  const parts = parsePattern(pattern);
  const order: FilenameTimeField[] = [];
  let source = '';
  for (const part of parts) {
    if (part.token) {
      order.push(part.token);
      source += `(\\d{${FIELD_WIDTH[part.token]}})`;
    } else {
      source += escapeRegExp(part.literal);
    }
  }

  let match: RegExpMatchArray | null;
  try {
    match = filename.match(new RegExp(source));
  } catch {
    return null;
  }
  if (!match) return null;

  const values = {} as Partial<Record<FilenameTimeField, number>>;
  order.forEach((field, i) => { values[field] = parseInt(match![i + 1], 10); });

  const year = values.year4 ?? (values.year2! < 70 ? 2000 + values.year2! : 1900 + values.year2!);
  const month = values.month!;
  const day = values.day!;
  const hour = values.hour ?? 0;
  const minute = values.minute ?? 0;
  const second = values.second ?? 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, second);
  // Reject dates JS silently rolled over (Feb 30 → Mar 2).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

const pad = (v: number, width: number): string => String(v).padStart(width, '0');

/**
 * Render `date` in `pattern` — the inverse of parseFilenameTime, used by the
 * settings preview to show what a filename in this scheme looks like.
 */
export function formatFilenameTime(date: Date, pattern: string): string {
  return parsePattern(pattern).map(part => {
    switch (part.token) {
      case 'year4': return pad(date.getFullYear(), 4);
      case 'year2': return pad(date.getFullYear() % 100, 2);
      case 'month': return pad(date.getMonth() + 1, 2);
      case 'day': return pad(date.getDate(), 2);
      case 'hour': return pad(date.getHours(), 2);
      case 'minute': return pad(date.getMinutes(), 2);
      case 'second': return pad(date.getSeconds(), 2);
      default: return part.literal;
    }
  }).join('');
}
