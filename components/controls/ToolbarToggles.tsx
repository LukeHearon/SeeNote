import { Settings, Activity, Scissors } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';

// The two icon toggles at the right end of the toolbar. Extracted so the help
// guide can render working copies of them (components/help/LiveControls.tsx)
// rather than descriptions.

/** Opens the buzzdetect panel. Only rendered when a buzzdetect dir is configured. */
export function BuzzdetectToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${enabled ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
      data-tooltip={tooltips.buzzdetectPanel}
      data-help-target="buzzdetect-toggle"
    >
      <Activity size={16} />
    </button>
  );
}

/**
 * Collapses the track to the ticked neurons' detections (utils/subsetTimeline.ts).
 * Only rendered when at least one neuron has been ticked to subset by — without
 * one there's nothing the button could do, so it isn't shown rather than
 * shown-and-inert.
 */
export function SubsetToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${active ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
      data-tooltip={tooltips.buzzdetectSubset}
      data-help-target="buzzdetect-subset-toggle"
    >
      <Scissors size={16} />
    </button>
  );
}

/** Shows/hides the spectrogram settings popover (controls/SpectrogramSettingsPanel). */
export function SpectrogramSettingsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${open ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
      data-tooltip={tooltips.spectrogramSettings}
      data-help-target="spectrogram-settings"
    >
      <Settings size={16} />
    </button>
  );
}
