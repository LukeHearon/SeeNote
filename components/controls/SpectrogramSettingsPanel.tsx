import { FrequencyScale, SpectrogramSettings } from '../../types';
import LevelRangeSlider from '../LevelRangeSlider';
import { annotationWindow } from '../../copy/ui';

const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192];

/**
 * Contents of the spectrogram settings popover — level range, frequency bounds,
 * FFT window size, frequency scale.
 *
 * The popover's positioning stays at the call site (it hangs off the toolbar
 * gear in both windows); this is just the body, so AnnotationWindow,
 * SingleFileWindow and the help guide all render the same controls.
 */
export function SpectrogramSettingsPanel({
  settings,
  onChange,
}: {
  settings: SpectrogramSettings;
  /** Partial update — merged into the existing settings by the caller. */
  onChange: (patch: Partial<SpectrogramSettings>) => void;
}) {
  return (
    <div className="p-4 space-y-6" data-help-target="spectrogram-settings-panel">
      <LevelRangeSlider
        floor={settings.displayFloor}
        ceil={settings.displayCeil}
        onChange={onChange}
      />

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.freqHeader}</h4>
        <div className="flex space-x-2 pt-2">
          <div className="flex-1">
            <label className="text-xs text-slate-400">{annotationWindow.freqMin}</label>
            <input
              type="number"
              value={settings.minFreq}
              onChange={e => onChange({ minFreq: Math.max(0, parseInt(e.target.value)) })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-slate-400">{annotationWindow.freqMax}</label>
            <input
              type="number"
              value={settings.maxFreq}
              onChange={e => onChange({ maxFreq: parseInt(e.target.value) })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.fftHeader}</h4>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">{annotationWindow.windowSize}</label>
          <select
            value={settings.fftSize}
            onChange={e => onChange({ fftSize: parseInt(e.target.value) })}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
          >
            {FFT_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">{annotationWindow.scaleLabel}</label>
          <select
            value={settings.frequencyScale}
            onChange={e => onChange({ frequencyScale: e.target.value as FrequencyScale })}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
          >
            <option value="linear">{annotationWindow.scaleLinear}</option>
            <option value="log">{annotationWindow.scaleLog}</option>
            <option value="mel">{annotationWindow.scaleMel}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
