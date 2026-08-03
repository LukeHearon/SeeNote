import { ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { postHelpMessage } from '../utils/helpChannel';
import { findPage } from './help/guide';
import { HelpPreviewCard } from './HelpPreviewCard';

const PREVIEW_DELAY = 450;

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
 *    `heading`); shown with a light background and a superscript arrow, and — on
 *    a longer hover — a HelpPreviewCard (styled like the guide page itself, not
 *    a generic tooltip) previewing the target page's title and opening blurb.
 */
export function HelpAnchor({ target, page, heading, onNavigate, onHighlight, children, as: Tag = 'span', className = '' }: HelpAnchorProps) {
  const previewPage = page ? findPage(page) : undefined;
  const elRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const onMouseEnter = () => {
    if (target) { postHelpMessage({ type: 'highlight', target }); onHighlight?.(target); }
    if (previewPage) timerRef.current = setTimeout(() => setShowPreview(true), PREVIEW_DELAY);
  };
  const onMouseLeave = () => {
    if (target) { postHelpMessage({ type: 'highlight', target: null }); onHighlight?.(null); }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setShowPreview(false);
  };

  const styles = [
    'transition-colors',
    // Independent per behavior, so a term with both applies both: the dotted
    // underline for the hover-highlight, the background pill for the
    // cross-reference — neither should stomp the other out.
    target ? 'cursor-pointer underline decoration-dotted decoration-sky-400 hover:text-sky-300' : '',
    page ? 'cursor-pointer rounded px-0.5 -mx-0.5 bg-sky-500/10 hover:bg-sky-500/20' : '',
  ].filter(Boolean).join(' ');

  return (
    <Tag
      ref={elRef as never}
      className={`${styles} ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
      {showPreview && previewPage && elRef.current && (
        <HelpPreviewCard page={previewPage} anchorRect={elRef.current.getBoundingClientRect()} />
      )}
    </Tag>
  );
}
