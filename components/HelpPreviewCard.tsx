import { createPortal } from 'react-dom';
import type { Page } from './help/guide';
import { pagePreview } from './help/guide';

interface Rect {
  top: number;
  left: number;
  bottom: number;
}

// The blurb clips to LINES_SHOWN lines of text: the first two render at full
// opacity, the third fades to half-legible, and the fourth trails off to
// nearly nothing — a soft trail-off instead of an ellipsis cutoff.
const LINE_HEIGHT_EM = 1.625; // matches leading-relaxed
const LINES_SHOWN = 4;
const FADE_LINES = 2;
const fadeStart = `${((LINES_SHOWN - FADE_LINES) / LINES_SHOWN) * 100}%`;

/**
 * A cross-reference's hover preview — styled like a shrunken version of the
 * guide page itself (HelpContent's own title/body classes), not a generic
 * tooltip, so it reads as a mini page popping up rather than a label.
 */
export function HelpPreviewCard({ page, anchorRect }: { page: Page; anchorRect: Rect }) {
  const margin = 8;
  const width = 260;
  let left = anchorRect.left;
  if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin;
  left = Math.max(margin, left);

  const fadeMask = `linear-gradient(to bottom, black ${fadeStart}, transparent 100%)`;

  return createPortal(
    <div
      className="fixed z-[9999] pointer-events-none w-[260px] bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-3"
      style={{ left, top: anchorRect.bottom + 6 }}
    >
      <div className="text-sm font-bold text-white leading-snug">{page.title()}</div>
      <p
        className="mt-1 text-xs text-slate-300"
        style={{
          lineHeight: LINE_HEIGHT_EM,
          maxHeight: `${LINE_HEIGHT_EM * LINES_SHOWN}em`,
          overflow: 'hidden',
          maskImage: fadeMask,
          WebkitMaskImage: fadeMask,
        }}
      >
        {pagePreview(page)}
      </p>
    </div>,
    document.body,
  );
}
