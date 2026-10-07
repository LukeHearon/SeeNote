import { ExternalLink } from 'lucide-react';
import { tooltips } from '../copy/tooltips';

/** The small corner button that sends a panel into its own window. */
export default function PopOutButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`p-1 rounded bg-black/40 text-slate-400 opacity-60 hover:opacity-100 hover:bg-slate-700 hover:text-white transition-all ${className}`}
      data-tooltip={tooltips.popOutPanel}
    >
      <ExternalLink size={13} />
    </button>
  );
}
