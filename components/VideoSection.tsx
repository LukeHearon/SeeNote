import type { ComponentProps, MouseEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import PopOutButton from './PopOutButton';
import VideoPane from './VideoPane';
import { tooltips } from '../copy/tooltips';
import { annotationWindow } from '../copy/ui';

export interface VideoSectionProps {
  pane: ComponentProps<typeof VideoPane>;
  collapsed: boolean;
  /** Fraction of the column the video takes when expanded. */
  splitRatio: number;
  collapsedBarPx: number;
  onExpand: () => void;
  onSplitDrag: (e: MouseEvent) => void;
  /** Nothing flexible below (those panels are popped out): take all the height and drop the split handle. */
  fill?: boolean;
  onPopOut?: () => void;
}

/** The video pane above the spectrogram, its collapsed bar, and the split handle. */
export default function VideoSection({ pane, collapsed, splitRatio, collapsedBarPx, onExpand, onSplitDrag, fill = false, onPopOut }: VideoSectionProps) {
  const bar = collapsed && !fill;
  return (
    <>
      <div
        style={fill ? undefined : { height: bar ? collapsedBarPx : `${splitRatio * 100}%` }}
        className={`bg-black relative flex ${fill ? 'flex-1 min-h-0' : 'flex-none'} overflow-hidden`}
        data-help-target="video-panel"
      >
        <VideoPane {...pane} />
        {onPopOut && !bar && <PopOutButton onClick={onPopOut} className="absolute bottom-2 left-2 z-30" />}
        {bar && (
          <div className="absolute inset-0 z-40 bg-slate-900 border-b border-slate-700 flex items-center px-3">
            <button
              type="button"
              onClick={onExpand}
              className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors"
              data-tooltip={tooltips.expandVideoPanel}
            >
              <ChevronDown size={16} />
              <span className="text-xs font-medium uppercase tracking-wide">{annotationWindow.videoLabel}</span>
            </button>
          </div>
        )}
      </div>

      {!fill && (
      <div
        className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
        onMouseDown={onSplitDrag}
      >
        <div className="w-12 h-1 bg-slate-600 rounded-full" />
      </div>
      )}
    </>
  );
}
