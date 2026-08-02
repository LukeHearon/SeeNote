import { ReactNode } from 'react';
import { postHelpMessage } from '../utils/helpChannel';

interface HelpAnchorProps {
  target: string;
  children: ReactNode;
  as?: 'span' | 'strong' | 'h1' | 'h2' | 'h4';
  className?: string;
}

/**
 * A term in the guide that points at a real control. Hovering it asks the main
 * SeeNote window to ghost the element carrying `data-help-target={target}`.
 *
 * The guide runs in its own window, so the measuring and the overlay itself
 * live over there — see components/HelpHighlightHost.tsx.
 */
export function HelpAnchor({ target, children, as: Tag = 'span', className = '' }: HelpAnchorProps) {
  return (
    <Tag
      className={`cursor-pointer underline decoration-dotted decoration-sky-400 hover:text-sky-300 transition-colors ${className}`}
      onMouseEnter={() => postHelpMessage({ type: 'highlight', target })}
      onMouseLeave={() => postHelpMessage({ type: 'highlight', target: null })}
    >
      {children}
    </Tag>
  );
}
