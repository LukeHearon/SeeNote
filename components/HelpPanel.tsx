import React from 'react';
import { X, BookOpen, Keyboard, Layers } from 'lucide-react';
import { HelpAnchor } from './HelpAnchor';
import { useHotkeys } from '../hooks/useHotkeys';
import { KeyboardShortcutsView } from './KeyboardShortcutsView';
import { helpPanel } from '../copy/help';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

type Tab = 'guide' | 'annotations' | 'shortcuts';

interface HelpPanelProps {
  open: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onClose: () => void;
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
    { id: 'guide', label: helpPanel.tabs.guide, icon: <BookOpen size={13} /> },
    { id: 'annotations', label: helpPanel.tabs.annotations, icon: <Layers size={13} /> },
    { id: 'shortcuts', label: helpPanel.tabs.shortcuts, icon: <Keyboard size={13} /> },
  ];

  // Close on Esc when the panel is open. `stop: true` blocks other hotkey
  // listeners so Esc doesn't also deactivate the active annotation tool.
  useHotkeys([
    { key: 'Escape', allowInInput: true, stop: true, handler: onClose },
  ], open);

  const tabPanelId = `help-tabpanel-${tab}`;

  const kbdRenderer = (text: string, key: number) => (
    <kbd key={key} className="font-mono bg-slate-700 px-1 rounded text-slate-200">{text}</kbd>
  );
  const anchorRenderer = (target: string, text: string, key: number) => (
    <HelpAnchor key={key} target={target}>{text}</HelpAnchor>
  );
  const opts = { codeRenderer: kbdRenderer, anchorRenderer };
  const md = (str: string) => renderInlineMarkdown(str, opts);

  return (
    <div
      role="dialog"
      aria-label={helpPanel.panelTitle}
      aria-modal="true"
      className={`fixed top-0 right-0 bottom-0 z-50 bg-slate-800 border-l border-slate-700 shadow-2xl flex flex-col transition-[transform,width] duration-300 ease-in-out ${tab === 'shortcuts' ? 'w-[520px]' : 'w-80'} ${open ? 'translate-x-0' : 'translate-x-full'}`}
    >
        {/* Header */}
        <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800">
          <span className="text-[#e65161] font-bold text-base">{helpPanel.panelTitle}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1 rounded hover:bg-slate-700">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label={helpPanel.tabsAriaLabel} className="flex-none flex border-b border-slate-700">
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
              <Section title={helpPanel.guideSections.projects}>
                <p>{md(helpPanel.guide.projects.p1)}</p>
                <p>{md(helpPanel.guide.projects.p2)}</p>
                <p>{md(helpPanel.guide.projects.p3)}</p>
              </Section>

              <Section title={helpPanel.guideSections.filePanel} target="file-panel">
                <p>{md(helpPanel.guide.filePanel.p1)}</p>
              </Section>

              <Section title={helpPanel.guideSections.videoMode}>
                <p>{md(helpPanel.guide.videoMode.intro)}</p>
                <ul className="space-y-1 list-none">
                  <li>{md(helpPanel.guide.videoMode.li_off)}</li>
                  <li>{md(helpPanel.guide.videoMode.li_fast)}</li>
                  <li>{md(helpPanel.guide.videoMode.li_mixed)}</li>
                  <li>{md(helpPanel.guide.videoMode.li_accurate)}</li>
                </ul>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoMode.note1)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoMode.note2)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoMode.note3)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoMode.note4)}</p>
              </Section>

              <Section title={helpPanel.guideSections.videoZoom} target="video-panel">
                <p>{md(helpPanel.guide.videoZoom.intro)}</p>
                <ul className="space-y-1 list-none">
                  <li>{md(helpPanel.guide.videoZoom.li1)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li2)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li3)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li4)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li5)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li6)}</li>
                  <li>{md(helpPanel.guide.videoZoom.li7)}</li>
                </ul>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoZoom.note1)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.videoZoom.note2)}</p>
              </Section>

              <Section title={helpPanel.guideSections.spectrogram} target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li>{md(helpPanel.guide.spectrogram.li1)}</li>
                  <li>{md(helpPanel.guide.spectrogram.li2)}</li>
                  <li>{md(helpPanel.guide.spectrogram.li3)}</li>
                  <li>{md(helpPanel.guide.spectrogram.li4)}</li>
                  <li>{md(helpPanel.guide.spectrogram.li5)}</li>
                </ul>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.spectrogram.note1)}</p>
              </Section>

              <Section title={helpPanel.guideSections.twoModes}>
                <ul className="space-y-2 list-none">
                  <li>{md(helpPanel.guide.twoModes.li1)}</li>
                  <li>{md(helpPanel.guide.twoModes.li2)}</li>
                </ul>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.twoModes.note1)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.twoModes.note2)}</p>
              </Section>

              <Section title={helpPanel.guideSections.transport} target="transport-buttons">
                <p>{md(helpPanel.guide.transport.p1)}</p>
                <p>{md(helpPanel.guide.transport.p2)}</p>
                <p>{md(helpPanel.guide.transport.p3)}</p>
              </Section>

              <Section title={helpPanel.guideSections.playbackSpeed} target="playback-speed">
                <p>{md(helpPanel.guide.playbackSpeed.p1)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.guide.playbackSpeed.note1)}</p>
              </Section>

              <Section title={helpPanel.guideSections.bandPassFilter} target="filter-tool">
                <p>{md(helpPanel.guide.bandPassFilter.p1)}</p>
                <p>{md(helpPanel.guide.bandPassFilter.p2)}</p>
                <p>{md(helpPanel.guide.bandPassFilter.p3)}</p>
                <p>{md(helpPanel.guide.bandPassFilter.p4)}</p>
                <p>{md(helpPanel.guide.bandPassFilter.p5)}</p>
              </Section>

              <Section title={helpPanel.guideSections.timeDisplay} target="time-display">
                <p>{md(helpPanel.guide.timeDisplay.p1)}</p>
                <p>{md(helpPanel.guide.timeDisplay.p2)}</p>
              </Section>

              <Section title={helpPanel.guideSections.autoSave}>
                <p>{md(helpPanel.guide.autoSave.p1)}</p>
              </Section>

              <Section title={helpPanel.guideSections.sync}>
                <p>{md(helpPanel.guide.sync.p1)}</p>
                <p>{md(helpPanel.guide.sync.p2)}</p>
                <p>{md(helpPanel.guide.sync.p3)}</p>
                <p>{md(helpPanel.guide.sync.p4)}</p>
                <p>{md(helpPanel.guide.sync.p5)}</p>
              </Section>

              <Section title={helpPanel.guideSections.buzzdetect} target="buzzdetect-toggle">
                <p>{md(helpPanel.guide.buzzdetect.p1)}</p>
                <p>{md(helpPanel.guide.buzzdetect.p2)}</p>
                <p>{md(helpPanel.guide.buzzdetect.p3)}</p>
              </Section>
            </>
          )}

          {tab === 'annotations' && (
            <>
              <Section title={helpPanel.annotationSections.tools} target="tool-palette">
                <p>{md(helpPanel.annotations.tools.p1)}</p>
                <p>{md(helpPanel.annotations.tools.p2)}</p>
                <p>{md(helpPanel.annotations.tools.p3)}</p>
                <p>{md(helpPanel.annotations.tools.p4)}</p>
                <p>{md(helpPanel.annotations.tools.p5)}</p>
                <p className="text-slate-400 text-xs">{md(helpPanel.annotations.tools.note1)}</p>
              </Section>

              <Section title={helpPanel.annotationSections.creating} target="spectrogram-canvas">
                <ul className="space-y-1 list-none">
                  <li>{md(helpPanel.annotations.creating.li1)}</li>
                  <li>{md(helpPanel.annotations.creating.li2)}</li>
                  <li>{md(helpPanel.annotations.creating.li3)}</li>
                </ul>
              </Section>

              <Section title={helpPanel.annotationSections.editing}>
                <ul className="space-y-1.5 list-none">
                  <li>{md(helpPanel.annotations.editing.li1)}</li>
                  <li>{md(helpPanel.annotations.editing.li2)}</li>
                  <li>{md(helpPanel.annotations.editing.li3)}</li>
                  <li>{md(helpPanel.annotations.editing.li4)}</li>
                  <li>{md(helpPanel.annotations.editing.li5)}</li>
                </ul>
              </Section>
            </>
          )}

          {tab === 'shortcuts' && <KeyboardShortcutsView />}

        </div>
      </div>
  );
}
