import React from 'react';
import { X, BookOpen, Keyboard, Layers } from 'lucide-react';
import { HelpAnchor } from './HelpAnchor';
import { useHotkeys } from '../hooks/useHotkeys';

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
  // Arrow keys cycle through the tabs (no stop — they're scoped enough that
  // other Arrow handlers don't matter while this panel is open).
  const cycleTab = (delta: number) => {
    const idx = tabs.findIndex(t => t.id === tab);
    onTabChange(tabs[(idx + delta + tabs.length) % tabs.length].id);
  };
  useHotkeys([
    { key: 'Escape', allowInInput: true, stop: true, handler: onClose },
    { key: 'ArrowLeft', allowInInput: true, handler: () => cycleTab(-1) },
    { key: 'ArrowRight', allowInInput: true, handler: () => cycleTab(1) },
  ], open);

  const tabPanelId = `help-tabpanel-${tab}`;

  return (
    <div
      role="dialog"
      aria-label="SeeNote Help"
      aria-modal="true"
      className={`fixed top-0 right-0 bottom-0 z-50 w-80 bg-slate-800 border-l border-slate-700 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
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
          className="flex-1 overflow-y-auto px-4 py-4 space-y-5 text-sm text-slate-300"
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
                  Configure output format (Audacity .txt, CSV, or JSON) and label categories via{' '}
                  <HelpAnchor target="project-settings-btn">Project Settings</HelpAnchor>.
                  All settings—including annotation tools and spectrogram display—persist per project.
                </p>
              </Section>

              <Section title="File Panel" target="file-panel">
                <p>
                  Lists every track in the project directory. Tracks with existing annotations show a count badge.
                  Click any track to open it, or use <Kbd>Cmd+↑</Kbd> / <Kbd>Cmd+↓</Kbd> to step through tracks in order.
                  Right-click a track to reveal in Finder or reveal its annotation file.
                </p>
              </Section>

              <Section title="Spectrogram" target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">Pan:</span> Right-click &amp; drag, or scroll wheel.</li>
                  <li><span className="text-white">Zoom:</span> <Kbd>Cmd/Ctrl</Kbd> + scroll wheel.</li>
                  <li><span className="text-white">Seek:</span> Left-click (in Selection Mode) to move the playhead.</li>
                  <li><span className="text-white">Play/Pause:</span> <Kbd>Space</Kbd>.</li>
                </ul>
                <p className="text-slate-400 text-xs">
                  <HelpAnchor target="spectrogram-settings">Spectrogram settings</HelpAnchor> (brightness, FFT size, frequency scale, range) are saved per project.
                </p>
              </Section>

              <Section title="Two Modes: Selection vs. Tool">
                <ul className="space-y-2 list-none">
                  <li>
                    <span className="text-white">Selection Mode</span> (press <Kbd>Esc</Kbd> to enter —{' '}
                    <HelpAnchor target="tool-palette">see palette</HelpAnchor>
                    ): left-click &amp; drag creates a <span className="italic">selection region</span>.
                    Playback is bounded to that region. While a selection is active, pressing a tool key (<Kbd>0</Kbd>–<Kbd>9</Kbd>) drops an annotation onto it.
                  </li>
                  <li>
                    <span className="text-white">Annotation Tool Mode</span> (a tool is active): left-click &amp; drag directly creates an annotation.
                    Press a number key to switch tools, or <Kbd>Esc</Kbd> to return to Selection Mode.
                  </li>
                </ul>
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
                  <HelpAnchor target="volume-control">volume slider</HelpAnchor>{' '}
                  supports up to 2× gain boost (slider past center). Press <Kbd>M</Kbd> to mute.
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
                  Click the{' '}
                  <HelpAnchor target="filter-tool">filter button</HelpAnchor>{' '}
                  (or press <Kbd>F</Kbd>) to enter filter mode, then drag vertically on the spectrogram to select a frequency band —
                  audio outside the band is attenuated in real time and the out-of-band region darkens visually.
                </p>
                <p>
                  Drag the two horizontal cutoff lines to retune the band. Use the{' '}
                  <HelpAnchor target="filter-strength">strength slider</HelpAnchor>{' '}
                  to mix between dry (0%, source untouched) and fully band-passed (100%).
                </p>
                <p>
                  <span className="text-white">Toggling on/off:</span> the filter tool and the filter itself are bound together — when the tool is active the filter is applied to playback and the band overlay is shown; when the tool is inactive both the audio effect and the visual overlay are removed. Press <Kbd>F</Kbd> (or click the filter button) to flip between the two states.
                </p>
                <p>
                  <span className="text-white">Persistence:</span> the band cutoffs and strength are saved into the project file, so the same filter is restored when the project is reopened and <Kbd>F</Kbd> quickly toggles it on and off without redrawing the band. The source audio is never modified and the spectrogram is not recomputed.
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
                  Click a tool name in the <HelpAnchor target="tool-palette">palette</HelpAnchor> to rename it; all existing annotations update automatically.
                  Use <Kbd>+</Kbd> to add a tool, or the trash icon to remove one.
                  Tool configuration is saved per project.
                </p>
              </Section>

              <Section title="Creating Annotations" target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">From scratch:</span> activate a tool, then drag on the spectrogram.</li>
                  <li><span className="text-white">From selection:</span> make a selection region, then press a tool key (<Kbd>0</Kbd>–<Kbd>9</Kbd>).</li>
                </ul>
              </Section>

              <Section title="Editing Annotations">
                <ul className="space-y-1.5 list-none">
                  <li><span className="text-white">Resize:</span> drag the left or right edge handle.</li>
                  <li>
                    <span className="text-white">Bound selection:</span> click the center of an annotation to bind the playhead loop to it.
                    Use <Kbd>Cmd+←</Kbd> / <Kbd>Cmd+→</Kbd> to jump between annotations.
                  </li>
                  <li><span className="text-white">Rename:</span> click the annotation's text label to edit inline. Custom tool annotations open for editing automatically.</li>
                  <li><span className="text-white">Delete:</span> select an annotation and press <Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd>, or middle-click it directly.</li>
                  <li><span className="text-white">Undo/Redo:</span> <Kbd>Cmd/Ctrl+Z</Kbd> / <Kbd>Cmd/Ctrl+Shift+Z</Kbd>.</li>
                </ul>
              </Section>
            </>
          )}

          {tab === 'shortcuts' && (
            <>
              <ShortcutGroup title="Playback" rows={[
                { keys: 'Space', label: 'Play / Pause' },
                { keys: 'M', label: 'Mute / Unmute' },
                { keys: 'F', label: 'Toggle band-pass filter' },
              ]} />

              <ShortcutGroup title="Spectrogram" rows={[
                { keys: 'Right-drag / Scroll', label: 'Pan' },
                { keys: 'Cmd/Ctrl + Scroll', label: 'Zoom' },
                { keys: 'Left-click (Selection Mode)', label: 'Seek' },
              ]} />

              <ShortcutGroup title="Navigation" rows={[
                { keys: '← / →', label: 'Scrub playhead ±10% zoom' },
                { keys: 'Cmd+← / →', label: 'Prev / Next annotation' },
                { keys: 'Cmd+↑ / ↓', label: 'Prev / Next file' },
              ]} />

              <ShortcutGroup title="Annotations" rows={[
                { keys: '0 – 9', label: 'Activate annotation tool' },
                { keys: 'Esc', label: 'Selection Mode / clear selection' },
                { keys: 'Delete / Backspace', label: 'Delete selected annotation' },
                { keys: 'Middle-click', label: 'Delete annotation instantly' },
                { keys: 'Cmd/Ctrl+Z', label: 'Undo' },
                { keys: 'Cmd/Ctrl+Shift+Z', label: 'Redo' },
              ]} />

              <ShortcutGroup title="App" rows={[
                { keys: 'F1 / ?', label: 'Toggle this help panel' },
              ]} />
            </>
          )}

        </div>
      </div>
  );
}
