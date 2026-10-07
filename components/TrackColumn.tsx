import type { ReactNode } from 'react';
import { ArrowDownLeft, Settings } from 'lucide-react';
import VideoPane from './VideoPane';
import VideoSection, { type VideoSectionProps } from './VideoSection';
import PopoutPortal from './PopoutPortal';
import PopOutButton from './PopOutButton';
import type { PanelId, PopoutsApi } from '../hooks/usePopouts';
import { popouts as copy, neuronPalette } from '../copy/ui';
import { tooltips } from '../copy/tooltips';

interface Props {
  popouts: PopoutsApi;
  /** Null on an audio track, which has no video panel. */
  video: VideoSectionProps | null;
  /** The transport toolbar. Never popped out. */
  toolbar: ReactNode;
  /** The spectrogram and anything laid over it. */
  spectrogram: ReactNode;
  /** The spectrogram settings popover; it travels with the spectrogram. */
  spectrogramSettings: { open: boolean; onToggle: () => void; panel: ReactNode };
  /** Null when the results panel isn't showing. `fill` is true when it should take the height it's given. */
  buzzdetect: null | {
    panel: (fill: boolean) => ReactNode;
    /** The graph settings, shown above the graph while the panel is popped out. */
    settings: ReactNode;
    settingsOpen: boolean;
    onToggleSettings: () => void;
  };
  /** Absolute overlays for the lower pane (the no-media notice). */
  overlay?: ReactNode;
}

const TITLES: Record<PanelId, () => string> = {
  video: () => copy.videoTitle,
  spectrogram: () => copy.spectrogramTitle,
  buzzdetect: () => copy.buzzdetectTitle,
};

function HeaderGear({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`p-1 rounded transition-colors ${on ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:bg-slate-700 hover:text-white'}`}
      data-tooltip={tooltips.spectrogramSettings}
    >
      <Settings size={14} />
    </button>
  );
}

/**
 * The column to the right of the sidebar: video above, the transport toolbar,
 * the spectrogram, then the buzzdetect results. Each of video / spectrogram /
 * results can be popped out into its own window (hooks/usePopouts.ts); the
 * rest then take its space, and a bar along the bottom brings any of them back.
 * The toolbar always stays here.
 */
export default function TrackColumn({ popouts, video, toolbar, spectrogram, spectrogramSettings, buzzdetect, overlay }: Props) {
  const videoPopped = video !== null && popouts.isPopped('video');
  const spectrogramPopped = popouts.isPopped('spectrogram');
  const buzzPopped = buzzdetect !== null && popouts.isPopped('buzzdetect');
  const buzzHere = buzzdetect !== null && !buzzPopped;

  // Below the toolbar, what can stretch: the spectrogram, or failing that the
  // results graph. With neither here, the video takes the whole column.
  const lowerStretches = !spectrogramPopped || buzzHere;
  const videoHere = video !== null && !videoPopped;
  const nothingHere = !videoHere && !lowerStretches;

  const poppedPanels: PanelId[] = [
    ...(videoPopped ? ['video' as const] : []),
    ...(spectrogramPopped ? ['spectrogram' as const] : []),
    ...(buzzPopped ? ['buzzdetect' as const] : []),
  ];

  const settingsPanel = spectrogramSettings.open && (
    <div className="absolute top-2 right-4 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-1rem)] overflow-y-auto custom-scrollbar flex flex-col">
      {spectrogramSettings.panel}
    </div>
  );

  const spectrogramBody = (popOutButton: ReactNode) => (
    <div className="flex-1 relative overflow-hidden">
      {spectrogram}
      {settingsPanel}
      {popOutButton}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col relative overflow-hidden">
      {/* Video — only for video tracks; audio-only tracks route playback
          through AudioEngine and never use the <video> element. */}
      {videoHere && (
        <VideoSection
          {...video}
          fill={!lowerStretches}
          onPopOut={() => popouts.popOut('video')}
        />
      )}
      {videoPopped && (
        <PopoutPortal title={copy.videoTitle} onClosed={() => popouts.popIn('video')}>
          <div className="relative flex flex-1 min-h-0 bg-black overflow-hidden">
            <VideoPane {...video.pane} />
          </div>
        </PopoutPortal>
      )}

      <div
        className={`relative min-h-0 bg-slate-900 border-t border-slate-700 flex flex-col ${lowerStretches ? 'flex-1' : 'flex-none'}`}
        data-help-target="spectrogram-canvas"
      >
        {toolbar}

        {!spectrogramPopped && spectrogramBody(
          <PopOutButton onClick={() => popouts.popOut('spectrogram')} className="absolute top-1 right-1 z-40" />,
        )}
        {spectrogramPopped && (
          <PopoutPortal
            title={copy.spectrogramTitle}
            onClosed={() => popouts.popIn('spectrogram')}
            headerActions={<HeaderGear on={spectrogramSettings.open} onClick={spectrogramSettings.onToggle} />}
          >
            {spectrogramBody(null)}
          </PopoutPortal>
        )}

        {buzzHere && (
          <div className={`relative ${spectrogramPopped ? 'flex-1 min-h-0 flex flex-col' : 'flex-none'}`}>
            {buzzdetect.panel(spectrogramPopped)}
            <PopOutButton onClick={() => popouts.popOut('buzzdetect')} className="absolute top-3 right-1 z-40" />
          </div>
        )}
        {buzzPopped && (
          <PopoutPortal
            title={copy.buzzdetectTitle}
            onClosed={() => popouts.popIn('buzzdetect')}
            headerActions={
              <button
                type="button"
                onClick={buzzdetect.onToggleSettings}
                className={`p-1 rounded transition-colors ${buzzdetect.settingsOpen ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:bg-slate-700 hover:text-white'}`}
                data-tooltip={neuronPalette.settingsTitle}
              >
                <Settings size={14} />
              </button>
            }
          >
            {buzzdetect.settingsOpen && buzzdetect.settings}
            {buzzdetect.panel(true)}
          </PopoutPortal>
        )}

        {overlay}
      </div>

      {nothingHere && (
        <div className="flex-1 flex items-center justify-center text-sm text-slate-600 pointer-events-none">
          {copy.allPoppedOut}
        </div>
      )}

      {poppedPanels.length > 0 && (
        <div className="flex-none h-8 flex items-center gap-2 px-2 bg-slate-900 border-t border-slate-700">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{copy.barLabel}</span>
          {poppedPanels.map(id => (
            <button
              key={id}
              type="button"
              onClick={() => popouts.popIn(id)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 hover:text-white transition-colors"
              data-tooltip={tooltips.popInPanel}
            >
              <ArrowDownLeft size={12} />
              {TITLES[id]()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
