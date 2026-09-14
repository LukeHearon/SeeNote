export const GITHUB_REPO = 'LukeHearon/SeeNote';
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export type Inline =
  | { kind: 'text' | 'bold' | 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'p'; inlines: Inline[] };

const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else out.push({ kind: 'link', text: m[3], url: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Minimal markdown for release notes: headings, flat bullet lists, paragraphs, bold/code/links. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: Inline[][] | null = null;

  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', inlines: parseInline(para.join(' ')) });
    if (list) blocks.push({ kind: 'list', items: list });
    para = [];
    list = null;
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) });
    } else if (item) {
      if (para.length) flush();
      (list ??= []).push(parseInline(item[1]));
    } else if (list) {
      const prev = list[list.length - 1];
      list[list.length - 1] = [...prev, { kind: 'text', text: ' ' }, ...parseInline(line)];
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** The updater manifest's notes are frozen at build time, before notes are written, so read the live release body. */
export async function fetchReleaseNotes(version: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const data = await res.json();
  return data.body ?? '';
}
