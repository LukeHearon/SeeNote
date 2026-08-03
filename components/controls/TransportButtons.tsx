import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Loader2, LocateFixed } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';
import { useAltHeld } from '../../hooks/useAltHeld';

export interface TransportButtonsProps {
  /** False when no track is loaded — everything greys out. */
  enabled: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  canGoPrevAnnotation: boolean;
  canGoNextAnnotation: boolean;
  playheadLocked: boolean;
  onSkipToStart: () => void;
  onSkipToEnd: () => void;
  onPrevAnnotation: () => void;
  onNextAnnotation: () => void;
  onPlay: () => void;
  onTogglePlayheadLock: () => void;
}

/**
 * [Start] [PrevAnnot] [Play] [NextAnnot] [End] [LockPlayhead].
 *
 * Shared by the toolbar and the help guide's live copy of it — see
 * components/help/LiveControl.tsx.
 */
export function TransportButtons({
  enabled,
  isPlaying,
  isBuffering,
  canGoPrevAnnotation,
  canGoNextAnnotation,
  playheadLocked,
  onSkipToStart,
  onSkipToEnd,
  onPrevAnnotation,
  onNextAnnotation,
  onPlay,
  onTogglePlayheadLock,
}: TransportButtonsProps) {
  // Alt suspends playhead lock — pale the lock icon to show it's momentarily inert
  // while leaving it in its active (locked) state.
  const altHeld = useAltHeld();
  const btn = 'p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none';

  return (
    <div className="flex items-center gap-1" data-help-target="transport-buttons">
      <button onClick={onSkipToStart} disabled={!enabled} className={btn} data-tooltip={tooltips.skipToStart}>
        <SkipBack size={15} />
      </button>
      <button
        onClick={onPrevAnnotation}
        disabled={!enabled || !canGoPrevAnnotation}
        className={btn}
        data-tooltip={tooltips.prevAnnotation}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        onClick={onPlay}
        disabled={!enabled}
        className="p-1.5 rounded-full bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 text-white transition-all shadow-lg flex-none mx-0.5"
      >
        <span className="flex items-center justify-center w-4 h-4">
          {isBuffering && !isPlaying
            ? <Loader2 size={16} className="animate-spin" />
            : isPlaying
              ? <Pause size={16} fill="currentColor" />
              : <Play size={16} fill="currentColor" />
          }
        </span>
      </button>
      <button
        onClick={onNextAnnotation}
        disabled={!enabled || !canGoNextAnnotation}
        className={btn}
        data-tooltip={tooltips.nextAnnotation}
      >
        <ChevronRight size={15} />
      </button>
      <button onClick={onSkipToEnd} disabled={!enabled} className={btn} data-tooltip={tooltips.skipToEnd}>
        <SkipForward size={15} />
      </button>
      <button
        onClick={onTogglePlayheadLock}
        disabled={!enabled}
        className={`p-1.5 rounded disabled:opacity-40 transition-colors flex-none ${playheadLocked ? `bg-slate-700 ${altHeld ? 'text-[#e65161]/40' : 'text-[#e65161]'}` : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
        data-tooltip={tooltips.lockPlayhead}
        data-help-target="recenter-playhead"
      >
        <LocateFixed size={15} />
      </button>
    </div>
  );
}
