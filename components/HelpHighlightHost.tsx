import { useEffect, useState } from 'react';
import { onHelpMessage } from '../utils/helpChannel';
import { HighlightOverlay } from './HighlightOverlay';

/**
 * Renders the ghost highlight over a real control when the help guide window
 * asks for it (HelpAnchor hover). Mount once per window that owns highlightable
 * controls — AnnotationWindow and SingleFileWindow.
 */
export function HelpHighlightHost() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => onHelpMessage(msg => {
    if (msg.type === 'highlight') setTarget(msg.target);
  }), []);

  return <HighlightOverlay target={target} />;
}
