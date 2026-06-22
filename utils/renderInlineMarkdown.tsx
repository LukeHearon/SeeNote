import React from 'react';

export function renderInlineMarkdown(
  text: string,
  options?: {
    codeRenderer?: (text: string, key: number) => React.ReactNode;
    anchorRenderer?: (target: string, text: string, key: number) => React.ReactNode;
  }
): React.ReactNode[] {
  const codeRenderer = options?.codeRenderer ?? ((t, k) => <code key={k}>{t}</code>);
  const anchorRenderer = options?.anchorRenderer ?? ((target, t, k) => <a key={k} href={target}>{t}</a>);

  // Token regex: **bold**, `code`, [text](target), _em_
  const tokenRe = /\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\)|_(.+?)_/g;

  const nodes: React.ReactNode[] = [];
  let key = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    // Plain text before this token
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      // **bold**
      nodes.push(<span key={key++} className="text-white font-medium">{match[1]}</span>);
    } else if (match[2] !== undefined) {
      // `code`
      nodes.push(codeRenderer(match[2], key++));
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // [text](target)
      nodes.push(anchorRenderer(match[4], match[3], key++));
    } else if (match[5] !== undefined) {
      // _em_
      nodes.push(<em key={key++}>{match[5]}</em>);
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
