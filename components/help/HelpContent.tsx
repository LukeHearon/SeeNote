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
const anchorRenderer = (target: string, text: string, key: number) => (
  <HelpAnchor key={key} target={target}>{text}</HelpAnchor>
);

/** Inline markdown with the guide's kbd + highlight-anchor renderers. */
export function md(text: string): React.ReactNode[] {
  return renderInlineMarkdown(text, { codeRenderer: kbdRenderer, anchorRenderer });
}

function renderBlock(block: Block, key: number, client: LiveClient): React.ReactNode {
  switch (block.kind) {
    case 'live':
      return <LiveControl key={key} id={block.control} client={client} />;
    case 'h':
      return (
        <h2
          key={key}
          id={`section-${block.id}`}
          data-toc-id={block.id}
          className="scroll-mt-4 pt-4 text-base font-semibold text-white"
        >
          {block.text}
        </h2>
      );
    case 'p':
      return <p key={key} className="leading-relaxed">{md(block.text)}</p>;
    case 'note':
      return <p key={key} className="text-xs text-slate-400 leading-relaxed">{md(block.text)}</p>;
    case 'ul':
      return (
        <ul key={key} className="space-y-1.5 list-none">
          {block.items.map((item, i) => <li key={i} className="leading-relaxed">{md(item)}</li>)}
        </ul>
      );
    case 'shortcuts':
      // KeyboardShortcutsView is h-full with an internally-scrolling list, so it
      // needs a bounded height rather than the content column's auto height.
      return <div key={key} className="h-[38rem]"><KeyboardShortcutsView /></div>;
  }
}

export function HelpContent({ page, client }: { page: Page; client: LiveClient }) {
  return (
    <article className={`space-y-3 text-sm text-slate-300 ${page.wide ? '' : 'max-w-3xl'}`}>
      <header className="pb-2">
        {page.target ? (
          <HelpAnchor target={page.target} as="h1" className="text-2xl font-bold text-white">
            {page.title()}
          </HelpAnchor>
        ) : (
          <h1 className="text-2xl font-bold text-white">{page.title()}</h1>
        )}
      </header>
      {page.blocks().map((block, i) => renderBlock(block, i, client))}
    </article>
  );
}
