import React from 'react';
import { X, BookOpen, Keyboard, Layers } from 'lucide-react';
import { HelpAnchor } from './HelpAnchor';
import { useHotkeys } from '../hooks/useHotkeys';
import { KeyboardShortcutsView } from './KeyboardShortcutsView';

type Tab = 'guide' | 'annotations' | 'shortcuts';

interface HelpPanelProps {
  open: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onClose: () => void;
}

function Kbd({ children }: { children: string }) {
  return <kbd className="font-mono bg-slate-700 px-1 rounded text-slate-200">{children}</kbd>;
}

function Section({ title, target, children }: { title: string; target?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      {target ? (
        <HelpAnchor target={target} as="h4" className="font-semibold text-white text-sm">
          {title}
        </HelpAnchor>
      ) : (
        <h4 className="font-semibold text-white text-sm">{title}</h4>
      )}
      {children}
    </section>
  );
}

function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="font-mono text-slate-400 text-xs shrink-0">{keys}</span>
      <span className="text-right">{label}</span>
    </div>
  );
}

function ShortcutGroup({ title, rows }: { title: string; rows: { keys: string; label: string }[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">{title}</p>
      {rows.map(r => <ShortcutRow key={r.keys} {...r} />)}
    </div>
  );
}

export function HelpPanel({ open, tab, onTabChange, onClose }: HelpPanelProps) {
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'guide', label: 'Guide', icon: <BookOpen size={13} /> },
    { id: 'annotations', label: 'Annotations', icon: <Layers size={13} /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={13} /> },
  ];

  // Close on Esc when the panel is open. `stop: true` blocks other hotkey
  // listeners so Esc doesn't also deactivate the active annotation tool.
  useHotkeys([
    { key: 'Escape', allowInInput: true, stop: true, handler: onClose },
  ], open);

  const tabPanelId = `help-tabpanel-${tab}`;

  return (
    <div
      role="dialog"
      aria-label="SeeNote Help"
      aria-modal="true"
      className={`fixed top-0 right-0 bottom-0 z-50 bg-slate-800 border-l border-slate-700 shadow-2xl flex flex-col transition-[transform,width] duration-300 ease-in-out ${tab === 'shortcuts' ? 'w-[520px]' : 'w-80'} ${open ? 'translate-x-0' : 'translate-x-full'}`}
    >
        {/* Header */}
        <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800">
          <span className="text-[#e65161] font-bold text-base">SeeNote Help</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1 rounded hover:bg-slate-700">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Help sections" className="flex-none flex border-b border-slate-700">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`help-tabpanel-${t.id}`}
              id={`help-tab-${t.id}`}
              onClick={() => onTabChange(t.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors border-b-2 ${
                tab === t.id
                  ? 'border-[#e65161] text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div
          role="tabpanel"
          id={tabPanelId}
          aria-labelledby={`help-tab-${tab}`}
          className={`flex-1 px-4 py-4 text-sm text-slate-300 ${tab === 'shortcuts' ? 'flex flex-col min-h-0' : 'overflow-y-auto space-y-5'}`}
        >

          {tab === 'guide' && (
            <>
              <Section title="Projects">
                <p>
                  SeeNote is organized around <span className="text-white">projects</span>. Each project links an{' '}
                  <span className="text-white">audio/video directory</span> to an{' '}
                  <span className="text-white">annotation output directory</span> where label files are saved.
                </p>
                <p>
                  Configure label categories and other settings via{' '}
                  <HelpAnchor target="project-settings-btn">Project Settings</HelpAnchor>.
                  All settings—including annotation tools and spectrogram display—persist per project.
                </p>
              </Section>

              <Section title="File Panel" target="file-panel">
                <p>
                  Lists every track in the project directory. Tracks with existing annotations are highlighted in the list.
                  Click any track to open it, or use <Kbd>Cmd+↑</Kbd> / <Kbd>Cmd+↓</Kbd> to step through tracks in order.
                  Right-click a track or folder to reveal its media location or annotation file in the system file manager.
                  Right-click a track and choose <span className="text-white">Import annotations…</span> to load annotations
                  from an external file; they are filed under that track's ident. If the track already has annotations, you
                  can <span className="text-white">Overwrite</span> them or <span className="text-white">Merge</span> (append the imported ones).
                </p>
              </Section>

              <Section title="Video Mode">
                <p>
                  The picker in the <span className="text-white">bottom-left corner of the video pane</span> chooses how video is rendered. Saved per project:
                </p>
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">Off:</span> no video — audio only. Lightest on the CPU.</li>
                  <li><span className="text-white">Fast:</span> the browser <span className="font-mono text-xs">&lt;video&gt;</span> element shows the picture and plays its <em>own</em> audio, free-running. Smooth and cheap, but not spectrogram-synced — no band-pass filter, no pitch-preserving slow-down, and the playhead is approximate. For machines that can't run Accurate.</li>
                  <li><span className="text-white">Mixed:</span> <span className="font-mono text-xs">&lt;video&gt;</span> (as in Fast) until you make a selection, then frame-accurate decoding for that region. Good for older hardware.</li>
                  <li><span className="text-white">Accurate:</span> frame-accurate WebCodecs decoding throughout (MP4/MOV only). Best fidelity, heaviest on the CPU.</li>
                </ul>
                <p className="text-slate-400 text-xs">
                  When the picture isn't sample-accurate with the audio, an inaccuracy badge appears in the video pane's top-left corner. If scrubbing or playback stutters, drop one level.
                </p>
                <p className="text-slate-400 text-xs">
                  Drag the divider below the video all the way up to collapse the pane to a bar; click the bar (or drag it back down) to restore it. Playback keeps running while collapsed.
                </p>
              </Section>

              <Section title="Video Zoom" target="video-panel">
                <p>
                  When the active track has video, controls appear at the{' '}
                  <span className="text-white">top-right</span> of the video panel.
                </p>
                <ul className="space-y-1 list-none">
                  <li><span className="text-white"><Kbd>Z</Kbd>:</span> toggle zoom state — restores your last zoomed viewport when turning on, saves it when turning off.</li>
                  <li><span className="text-white"><Kbd>Shift+Z</Kbd>:</span> toggle the marquee drawing tool. While armed, drag a box over the video to zoom into that region. Press <Kbd>Esc</Kbd> mid-drag to cancel.</li>
                  <li><span className="text-white"><Kbd>=</Kbd> / <Kbd>+</Kbd> / <Kbd>-</Kbd>:</span> zoom in / out from the current viewport center (while zoomed).</li>
                  <li><span className="text-white">Pan:</span> while zoomed, scroll (trackpad two-finger or mouse wheel) over the video panel to pan around.</li>
                  <li><span className="text-white">Zoom in / out / reset:</span> buttons available whenever zoomed in.</li>
                  <li><span className="text-white">Viewfinder:</span> while zoomed, a minimap appears bottom-right — drag inside it to pan the view.</li>
                </ul>
                <p className="text-slate-400 text-xs">
                  Zoom is purely visual and never affects the playhead, audio, or annotation timing.
                </p>
              </Section>

              <Section title="Spectrogram" target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">Pan:</span> Right-click &amp; drag, or scroll wheel.</li>
                  <li><span className="text-white">Zoom:</span> <Kbd>Cmd/Ctrl</Kbd> + scroll wheel.</li>
                  <li><span className="text-white">Seek:</span> Left-click (in Selection Mode) to move the playhead.</li>
                  <li><span className="text-white">Play/Pause:</span> <Kbd>Space</Kbd>.</li>
                  <li><span className="text-white">Toggle speed (1× ↔ last):</span> <Kbd>R</Kbd>.</li>
                </ul>
                <p className="text-slate-400 text-xs">
                  <HelpAnchor target="spectrogram-settings">Spectrogram settings</HelpAnchor> (FFT size, frequency scale, frequency range, display floor/ceiling) are saved per project. The <span className="text-white">Floor</span> and <span className="text-white">Ceil</span> dBFS controls set the dynamic range window: slide Floor toward −140 to reveal faint noise-floor detail, or toward 0 to crush it to black.
                </p>
              </Section>

              <Section title="Two Modes: Selection vs. Tool">
                <ul className="space-y-2 list-none">
                  <li>
                    <span className="text-white">Selection Mode</span> (press <Kbd>S</Kbd> to enter —{' '}
                    <HelpAnchor target="tool-palette">see palette</HelpAnchor>
                    ): left-click &amp; drag creates a <span className="italic">selection region</span>.
                    Playback is bounded to that region. While a selection is active, pressing a tool key (<Kbd>0</Kbd>–<Kbd>9</Kbd>) drops an annotation onto it.
                  </li>
                  <li>
                    <span className="text-white">Annotation Tool Mode</span> (a tool is active): left-click &amp; drag directly creates an annotation.
                    Press a number key to switch tools, or <Kbd>S</Kbd> to return to Selection Mode.
                  </li>
                </ul>
                <p className="text-slate-400 text-xs">
                  A selection that overlaps an annotation pops that annotation's name to the selection's
                  start, so the label stays next to where you're looking. If there's no room before the
                  annotation's right edge, the name right-justifies against it instead.
                </p>
                <p className="text-slate-400 text-xs">
                  <Kbd>Esc</Kbd> is the universal undo-layer key: it pops the most recently activated layer
                  (band, filter-tool, selection, annotation tool) in the reverse order you turned them on.
                </p>
              </Section>

              <Section title="Transport Controls" target="transport-buttons">
                <p>
                  The{' '}
                  <HelpAnchor target="transport-buttons">transport buttons</HelpAnchor>{' '}
                  let you skip to the start/end of the file, step between annotations, and play/pause.
                  Press <Kbd>Space</Kbd> to play or pause from anywhere.
                </p>
                <p>
                  The{' '}
                  <HelpAnchor target="recenter-playhead">recenter button</HelpAnchor>{' '}
                  (or <Kbd>C</Kbd>) pans the spectrogram so the playhead sits back in the
                  center of the visible window, without changing the zoom level. Useful after
                  scrolling away or jumping to a time off-screen.
                </p>
                <p>
                  The{' '}
                  <HelpAnchor target="volume-control">volume slider</HelpAnchor>{' '}
                  supports up to 2× gain boost (slider past center). Press <Kbd>M</Kbd> to mute.
                  Right-click the volume control to access <strong>Restart Audio</strong>, which
                  re-initialises the audio engine (useful after an audio device change on Windows).
                </p>
              </Section>

              <Section title="Playback Speed" target="playback-speed">
                <p>
                  The{' '}
                  <HelpAnchor target="playback-speed">speed slider</HelpAnchor>{' '}
                  scrubs playback between <span className="font-mono text-xs">0.25x</span> and{' '}
                  <span className="font-mono text-xs">4.0x</span>. Pitch is preserved, so slowing audio down
                  to inspect a transient won't drop it into a different octave.
                  Center snaps to <span className="font-mono text-xs">1.0x</span>; scroll-wheel over the slider also nudges the value.
                </p>
                <p className="text-slate-400 text-xs">
                  Speed is saved per project. Video tracks follow the audio clock, so frames stay in sync at any speed.
                </p>
              </Section>

              <Section title="Band-Pass Filter" target="filter-tool">
                <p>
                  Press <Kbd>Shift+F</Kbd> (or click the{' '}
                  <HelpAnchor target="filter-tool">filter button</HelpAnchor>) to ready the filter tool —
                  the cursor flips to a horizontal bar. Drag vertically on the spectrogram to draw a band:
                  audio outside the band is attenuated in real time, the out-of-band region darkens,
                  and the filter engages automatically.
                </p>
                <p>
                  Drag the two horizontal cutoff lines to retune the band in place — they're grabbable
                  any time a band is active, even when the filter tool isn't selected. Use the{' '}
                  <HelpAnchor target="filter-strength">strength slider</HelpAnchor>{' '}
                  to mix between dry (0%, source untouched) and fully band-passed (100%).
                  Dragging the slider up from 0 re-enables filtering at the new strength,
                  restoring the last band you drew.
                </p>
                <p>
                  <span className="text-white">F toggles filtering on/off</span>, saving and restoring the last defined band — just like <Kbd>Z</Kbd> for video zoom.
                  If you've never drawn a band, F engages a default 500 Hz–4 kHz band at 50% so you can hear something immediately and refine from there.
                  Tool readiness (<Kbd>Shift+F</Kbd>) is independent: a drawn band keeps filtering even after the tool is unreadied.
                </p>
                <p>
                  <Kbd>Esc</Kbd> unwinds the most recent layer: first the band (and filtering), then the
                  filter tool itself, then selection, then the annotation tool — in the order you turned them on.
                </p>
                <p>
                  <span className="text-white">Persistence:</span> the band cutoffs and strength are saved into the project file. The source audio is never modified and the spectrogram is not recomputed.
                </p>
              </Section>

              <Section title="Time Display" target="time-display">
                <p>
                  The{' '}
                  <HelpAnchor target="current-time">running time</HelpAnchor>{' '}
                  shows the playhead position in seconds. Click it to type a timestamp and jump directly to that position.
                </p>
                <p>
                  The{' '}
                  <HelpAnchor target="selection-time">selection fields</HelpAnchor>{' '}
                  show the active selection's start (<span className="font-mono text-xs text-slate-300">from</span>),
                  end (<span className="font-mono text-xs text-slate-300">to</span>), and
                  duration (<span className="font-mono text-xs text-slate-300">dur</span>) in seconds.
                  Click any field to edit it and nudge the selection boundaries precisely.
                </p>
              </Section>

              <Section title="Auto-save">
                <p>
                  Annotations save automatically every time you make a change. The file structure mirrors the audio directory.
                  Clearing all annotations removes the annotation file.
                </p>
              </Section>

              <Section title="buzzdetect panel" target="buzzdetect-toggle">
                <p>
                  Set a <span className="text-white">buzzdetect directory</span> under <span className="text-white">Advanced</span> when
                  creating or editing a project to plot per-frame neuron activations below the spectrogram, located per track by ident
                  (<span className="font-mono text-xs text-slate-300">{'{ident}_buzzdetect.csv'}</span>). Toggle the panel with the
                  <HelpAnchor target="buzzdetect-toggle"> activity icon</HelpAnchor> in the toolbar.
                </p>
                <p>
                  Each neuron is one colored line; its dots are filled where the value meets that neuron's threshold and open below it.
                  Open the panel's <span className="text-white">sliders</span> popover to set per-neuron thresholds and show/hide neurons.
                  <span className="text-white"> Click a frame</span> to select (and highlight) its audio on the spectrogram;
                  drag across frames to extend the selection. Drag the panel's top edge to resize it.
                </p>
              </Section>
            </>
          )}

          {tab === 'annotations' && (
            <>
              <Section title="Annotation Tools" target="tool-palette">
                <p>
                  Annotation tools are named labels bound to hotkeys <Kbd>0</Kbd>–<Kbd>9</Kbd>.
                  Key <Kbd>0</Kbd> is always the <span className="text-white">Custom Tool</span> — annotations created with it open immediately for you to type a one-off name.
                </p>
                <p>
                  Open <HelpAnchor target="tool-palette">Annotation Tool Settings</HelpAnchor> (gear icon) to manage tools: drag tools between hotkey slots and the Unassigned bin, click a tool's gear to edit its label and color, or hover a tool and click the trash icon to delete it (deletes are undoable). Hover an empty hotkey slot to create a new tool directly on that key.
                  Renaming a tool updates all existing annotations automatically. Tool configuration is saved per project.
                </p>
                <p className="text-slate-400 text-xs">
                  Inside Annotation Tool Settings, <Kbd>Cmd/Ctrl+Z</Kbd> / <Kbd>Cmd/Ctrl+Shift+Z</Kbd> undo and redo the last tool change.
                </p>
              </Section>

              <Section title="Creating Annotations" target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">From scratch:</span> activate a tool, then drag on the spectrogram.</li>
                  <li><span className="text-white">From selection:</span> make a selection region, then press a tool key (<Kbd>0</Kbd>–<Kbd>9</Kbd>).</li>
                  <li><span className="text-white">Whole track:</span> with a tool active, press <Kbd>Cmd/Ctrl+A</Kbd> to annotate the entire track (with no tool active it selects the whole track instead).</li>
                </ul>
              </Section>

              <Section title="Editing Annotations">
                <ul className="space-y-1.5 list-none">
                  <li><span className="text-white">Resize:</span> drag the left or right edge handle.</li>
                  <li>
                    <span className="text-white">Bound selection:</span> click the center of an annotation to bind the playhead loop to it.
                    Use <Kbd>Cmd+←</Kbd> / <Kbd>Cmd+→</Kbd> to jump between annotations.
                  </li>
                  <li><span className="text-white">Rename:</span> hover an annotation and click the pencil icon to edit inline. Custom tool annotations open for editing automatically.</li>
                  <li><span className="text-white">Delete:</span> select an annotation and press <Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd>, or middle-click it directly.</li>
                  <li><span className="text-white">Undo/Redo:</span> <Kbd>Cmd/Ctrl+Z</Kbd> / <Kbd>Cmd/Ctrl+Shift+Z</Kbd>.</li>
                </ul>
              </Section>
            </>
          )}

          {tab === 'shortcuts' && <KeyboardShortcutsView />}

        </div>
      </div>
  );
}
