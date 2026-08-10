import { Settings, Activity, Scissors } from 'lucide-react';
import { tooltips } from '../../copy/tooltips';

// The icon toggles for the spectrogram and buzzdetect. Extracted so the help
// guide can render working copies of them (components/help/LiveControls.tsx)
// rather than descriptions.
//
// `compact` shrinks a toggle to sit in a sidebar section header beside the
// other 12px header buttons; the default size is the toolbar's. Same component
// either way, so the guide's live copy behaves exactly like the real control
// wherever that control happens to live.
interface ToggleProps {
  onToggle: () => void;
  compact?: boolean;
}

// Class strings are written out in full rather than interpolated: Tailwind
// scans source text for class names, so a name assembled at runtime is purged.
const toggleClass = (on: boolean, compact: boolean) => {
  const pad = compact ? 'p-0.5' : 'p-1.5';
  const rest = on
    ? 'bg-slate-700 text-[#e65161]'
    : compact
      ? 'text-slate-500 hover:bg-slate-700 hover:text-slate-200'
      : 'text-slate-400 hover:bg-slate-700 hover:text-white';
  return `${pad} rounded transition-colors ${rest}`;
};

/**
 * Shows/hides the buzzdetect results panel below the spectrogram. Lives in the
 * Neurons section header, which is itself only present when the project names a
 * buzzdetect directory — so the button never appears with nothing to show.
 */
export function BuzzdetectToggle({ enabled, onToggle, compact = false }: ToggleProps & { enabled: boolean }) {
  return (
    <button
      onClick={onToggle}
      className={toggleClass(enabled, compact)}
      data-tooltip={tooltips.buzzdetectPanel}
      data-help-target="buzzdetect-toggle"
    >
      <Activity size={compact ? 12 : 16} />
    </button>
  );
}

/**
 * Collapses the track to the picked neurons' detections (utils/subsetTimeline.ts)
 * — "subset by everything the palette's Subset at boxes name" vs "by nothing".
 * Only rendered when at least one neuron has a Subset at value: without one
 * there's nothing the button could do, so it isn't shown rather than
 * shown-and-inert.
 *
 * Unlike the spectrogram settings button it is NOT in the toolbar — it lives in
 * the Neurons section header (components/NeuronPalette.tsx), beside the Subset
 * at thresholds that key it. It stays in this module because the help guide
 * renders it live from here alongside the other toggles, and it has the same
 * shape: state in, callback out.
 */
export function SubsetToggle({ active, onToggle, compact = false }: ToggleProps & { active: boolean }) {
  return (
    <button
      onClick={onToggle}
      className={toggleClass(active, compact)}
      data-tooltip={tooltips.buzzdetectSubset}
      data-help-target="buzzdetect-subset-toggle"
    >
      <Scissors size={compact ? 12 : 16} />
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
