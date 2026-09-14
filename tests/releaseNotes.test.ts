import { describe, it, expect } from 'vitest';
import { parseInline, parseMarkdown } from '../utils/releaseNotes';

describe('parseInline', () => {
  it('splits bold, code, and links out of plain text', () => {
    expect(parseInline('a **b** `c` [d](https://e)')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'd', url: 'https://e' },
    ]);
  });

  it('returns plain text unchanged', () => {
    expect(parseInline('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, lists, and paragraphs', () => {
    const md = 'Intro line\nstill intro\n\n## Section\n- one\n- two\n\nOutro';
    expect(parseMarkdown(md)).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'Intro line still intro' }] },
      { kind: 'heading', level: 2, inlines: [{ kind: 'text', text: 'Section' }] },
      { kind: 'list', items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]] },
      { kind: 'p', inlines: [{ kind: 'text', text: 'Outro' }] },
    ]);
  });

  it('joins a wrapped continuation line onto the previous list item', () => {
    const blocks = parseMarkdown('- first\n  continued\n- second');
    expect(blocks).toEqual([
      {
        kind: 'list',
        items: [
          [{ kind: 'text', text: 'first' }, { kind: 'text', text: ' ' }, { kind: 'text', text: 'continued' }],
          [{ kind: 'text', text: 'second' }],
        ],
      },
    ]);
  });

  it('handles CRLF and a heading directly after a list', () => {
    expect(parseMarkdown('* a\r\n### H')).toEqual([
      { kind: 'list', items: [[{ kind: 'text', text: 'a' }]] },
      { kind: 'heading', level: 3, inlines: [{ kind: 'text', text: 'H' }] },
    ]);
  });

  it('returns no blocks for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
