import { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { postHelpMessage } from '../utils/helpChannel';

interface HelpAnchorProps {
  /** `data-help-target` to ghost in the main window (and the guide's own embedded chip) on hover. */
  target?: string;
  /** Guide page id to jump to on click — renders the superscript cross-reference icon. */
  page?: string;
  /** Subsection within `page` to scroll to, if any. */
  heading?: string;
  onNavigate?: (page: string, heading?: string) => void;
  /** Mirrors the hover target into local state, so the guide can ghost its own embedded chip. */
  onHighlight?: (target: string | null) => void;
  children: ReactNode;
  as?: 'span' | 'strong' | 'h1' | 'h2' | 'h4';
  className?: string;
}

/**
 * A term in the guide. Two independent behaviors, either or both may apply:
 *  - `target`: hovering ghosts the element carrying `data-help-target={target}`,
 *    both in the main SeeNote window and in the guide's own embedded chips.
 *  - `page`: clicking navigates the guide to that page (optionally scrolling to
 *    `heading`); rendered with a small superscript arrow so it reads as a link.
 */
export function HelpAnchor({ target, page, heading, onNavigate, onHighlight, children, as: Tag = 'span', className = '' }: HelpAnchorProps) {
  const hoverHandlers = target ? {
    onMouseEnter: () => { postHelpMessage({ type: 'highlight', target }); onHighlight?.(target); },
    onMouseLeave: () => { postHelpMessage({ type: 'highlight', target: null }); onHighlight?.(null); },
  } : {};

  const styles = [
    'transition-colors',
    target ? 'cursor-pointer underline decoration-dotted decoration-sky-400 hover:text-sky-300' : '',
    page ? 'cursor-pointer hover:text-sky-300' : '',
    page && !target ? 'underline decoration-sky-500' : '',
  ].filter(Boolean).join(' ');

  return (
    <Tag
      className={`${styles} ${className}`}
      {...hoverHandlers}
      onClick={page ? () => onNavigate?.(page, heading) : undefined}
    >
      {children}
      {page && (
        <ArrowUpRight
          size={10}
          strokeWidth={2.5}
          className="inline-block align-super opacity-70 -translate-y-px"
          aria-hidden
        />
      )}
    </Tag>
  );
}
