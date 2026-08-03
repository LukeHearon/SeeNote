import React from 'react';
import { Block, Page } from './guide';
import { HelpAnchor } from '../HelpAnchor';
import { KeyboardShortcutsView } from '../KeyboardShortcutsView';
import { LiveControl } from './LiveControls';
import { renderInlineMarkdown } from '../../utils/renderInlineMarkdown';
import type { LiveClient } from '../../utils/liveBridge';

const kbdRenderer = (text: string, key: number) => (
  <kbd key={key} className="font-mono bg-slate-700 px-1 rounded text-slate-200">{text}</kbd>
);

/**
 * A link's target string is either a bare `data-help-target` (hover highlight
 * only — the original behavior) or that plus `@pageId[#headingId]` for a
 * cross-reference: `@pageId` on its own is a cross-reference with no hover
 * highlight; `highlight-target@pageId` gets both.
 */
function parseLinkTarget(raw: string): { target?: string; page?: string; heading?: string } {
  const at = raw.indexOf('@');
  if (at === -1) return { target: raw };
  const target = raw.slice(0, at) || undefined;
  const [page, heading] = raw.slice(at + 1).split('#');
  return { target, page: page || undefined, heading: heading || undefined };
}

export interface NavigateFn {
  (page: string, heading?: string): void;
}

/** Inline markdown with the guide's kbd + anchor renderers. */
export function md(text: string, onNavigate: NavigateFn, onHighlight: (target: string | null) => void): React.ReactNode[] {
  const anchorRenderer = (raw: string, linkText: string, key: number) => {
    const { target, page, heading } = parseLinkTarget(raw);
    return (
      <HelpAnchor key={key} target={target} page={page} heading={heading} onNavigate={onNavigate} onHighlight={onHighlight}>
        {linkText}
      </HelpAnchor>
    );
  };
  return renderInlineMarkdown(text, { codeRenderer: kbdRenderer, anchorRenderer });
}

function renderBlock(block: Block, key: number, client: LiveClient, onNavigate: NavigateFn, onHighlight: (target: string | null) => void): React.ReactNode {
  const t = (text: string) => md(text, onNavigate, onHighlight);
  switch (block.kind) {
    case 'live':
      return <LiveControl key={key} id={block.control} client={client} />;
    case 'h':
      return (
        <h2
          key={key}
          id={`section-${block.id}`}
          className="scroll-mt-4 pt-4 text-base font-semibold text-white"
        >
          {block.text}
        </h2>
      );
    case 'p':
      return <p key={key} className="leading-relaxed">{t(block.text)}</p>;
    case 'note':
      return <p key={key} className="text-xs text-slate-400 leading-relaxed">{t(block.text)}</p>;
    case 'ul':
      return (
        <ul key={key} className="space-y-1.5 list-none">
          {block.items.map((item, i) => <li key={i} className="leading-relaxed">{t(item)}</li>)}
        </ul>
      );
    case 'shortcuts':
      // KeyboardShortcutsView is h-full with an internally-scrolling list, so it
      // needs a bounded height rather than the content column's auto height.
      return <div key={key} className="h-[38rem]"><KeyboardShortcutsView /></div>;
  }
}

export function HelpContent({ page, client, onNavigate, onHighlight }: {
  page: Page;
  client: LiveClient;
  onNavigate: NavigateFn;
  onHighlight: (target: string | null) => void;
}) {
  return (
    <article className={`space-y-3 text-sm text-slate-300 ${page.wide ? '' : 'max-w-3xl'}`}>
      <header className="pb-2">
        {page.target ? (
          <HelpAnchor target={page.target} onHighlight={onHighlight} as="h1" className="text-2xl font-bold text-white">
            {page.title()}
          </HelpAnchor>
        ) : (
          <h1 className="text-2xl font-bold text-white">{page.title()}</h1>
        )}
      </header>
      {page.blocks().map((block, i) => renderBlock(block, i, client, onNavigate, onHighlight))}
    </article>
  );
}
