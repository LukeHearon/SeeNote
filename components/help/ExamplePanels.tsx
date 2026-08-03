import { ReactNode, useEffect, useRef, useState } from 'react';
import { BuzzdetectSeriesMode, Selection } from '../../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT, Y_AXIS_WIDTH } from '../../constants';
import { createCurrentTimeStore } from '../../utils/currentTimeStore';
import { createViewportStore } from '../../utils/viewportStore';
import {
  DEMO_DURATION,
  DEMO_IDENT,
  DEMO_ROOT,
  DEMO_TRACK,
  demoAnnotatedTracks,
  demoAnnotations,
  demoFiles,
  demoNonMediaFiles,
  makeDemoBuzzdetectData,
} from '../../utils/demoProject';
import { help } from '../../copy/help';
import BuzzdetectPanel from '../BuzzdetectPanel';
import FileTree from '../FileTree';
import MassRenameModal from '../MassRenameModal';

// Panels the guide renders against the example project (utils/demoProject.ts)
// rather than the open one. They are the real components — only their data is
// fixture — so they can't drift from what the app actually does.

/**
 * The file panel, browsable. Selecting a file, filtering, shuffling and
 * expanding all work; the entries just aren't real files, so the actions that
 * would touch the filesystem (reveal, import) are inert.
 */
export function ExampleFilePanel() {
  const [currentTrack, setCurrentTrack] = useState<string | null>(DEMO_TRACK);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [fileFilter, setFileFilter] = useState<'all' | 'annotated' | 'unannotated'>('all');

  // The real file panel is handed a pre-filtered list by AnnotationWindow, so
  // the example applies the same filter here for the button to visibly do
  // something.
  const files = demoFiles.filter(f =>
    fileFilter === 'all' ? true
      : fileFilter === 'annotated' ? demoAnnotatedTracks.has(f)
      : !demoAnnotatedTracks.has(f));

  const index = currentTrack ? files.indexOf(currentTrack) : -1;
  const step = (delta: number) => {
    const next = files[index + delta];
    if (next) setCurrentTrack(next);
  };

  return (
    <div className="w-72 h-80 rounded border border-slate-700 overflow-hidden">
      <FileTree
        rootDirectory={DEMO_ROOT}
        allFiles={files}
        allFilesUnfiltered={demoFiles}
        currentTrack={currentTrack}
        onFileSelect={setCurrentTrack}
        collapsed={false}
        onToggleCollapse={() => {}}
        onNavigatePrev={() => step(-1)}
        onNavigateNext={() => step(1)}
        canNavigatePrev={index > 0}
        canNavigateNext={index >= 0 && index < files.length - 1}
        shuffleMode={shuffleMode}
        onToggleShuffle={() => setShuffleMode(v => !v)}
        annotatedTracks={demoAnnotatedTracks}
        fileFilter={fileFilter}
        onToggleFileFilter={() => setFileFilter(f =>
          f === 'all' ? 'unannotated' : f === 'unannotated' ? 'annotated' : 'all')}
        onRevealInFinder={() => {}}
        onRevealAnnotations={() => {}}
        onImportAnnotations={() => {}}
        onRefresh={() => {}}
        nonMediaFiles={demoNonMediaFiles}
      />
    </div>
  );
}

/**
 * A modal, shown in place.
 *
 * Every modal in the app owns its own `fixed inset-0` backdrop, which would
 * cover the whole guide window. A `transform` on an ancestor makes it the
 * containing block for fixed-position descendants, so the modal lays itself out
 * inside this box instead — no modal has to grow an "inline" variant, and what
 * the reader sees is exactly what the app shows.
 */
function ModalStage({ children }: { children: ReactNode }) {
  return (
    <div className="relative w-full h-[26rem] transform-gpu overflow-hidden rounded border border-slate-700 bg-slate-900/40">
      {children}
    </div>
  );
}

/** Re-opens a dismissed example modal — nothing else would bring it back. */
function ReopenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <button
        onClick={onClick}
        className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
      >
        {label}
      </button>
    </div>
  );
}

/**
 * Mass Rename over the example project's annotations. The real modal merges
 * in-memory counts for the current track with a disk scan of every other track;
 * the example project has one track, so the scan finds nothing to read and the
 * counts shown are the in-memory ones.
 */
export function ExampleMassRename() {
  const [annotations, setAnnotations] = useState(demoAnnotations);
  const [open, setOpen] = useState(true);

  return (
    <ModalStage>
      {open ? (
        <MassRenameModal
          annotations={annotations}
          allTracks={[DEMO_TRACK]}
          trackPath={DEMO_TRACK}
          ident={DEMO_IDENT}
          getAnnotationPath={() => null}
          getIdent={() => DEMO_IDENT}
          onClose={() => setOpen(false)}
          onApply={async (oldText, newText) => {
            const hits = annotations.filter(a => a.text === oldText);
            setAnnotations(list => list.map(a => (a.text === oldText ? { ...a, text: newText } : a)));
            return hits.length;
          }}
        />
      ) : (
        <ReopenButton label={help.live.reopen} onClick={() => setOpen(true)} />
      )}
    </ModalStage>
  );
}

/**
 * The buzzdetect panel over synthetic activations. Thresholds, per-neuron
 * colours, hiding, the series toggle and the bin-width override are all live
 * against local state — everything except the spectrogram the real panel is
 * x-aligned to, which the guide window doesn't have. The viewport is pinned so
 * the whole example track spans the panel's width.
 */
export function ExampleBuzzdetectPanel() {
  const areaRef = useRef<HTMLDivElement>(null);
  const storesRef = useRef<{
    viewport: ReturnType<typeof createViewportStore>;
    time: ReturnType<typeof createCurrentTimeStore>;
    data: ReturnType<typeof makeDemoBuzzdetectData>;
  } | null>(null);
  if (!storesRef.current) {
    storesRef.current = {
      viewport: createViewportStore(),
      time: createCurrentTimeStore(),
      data: makeDemoBuzzdetectData(),
    };
    storesRef.current.time.set(22);
  }
  const { viewport, time, data } = storesRef.current;

  const [thresholds, setThresholds] = useState<Record<string, number>>({});
  const [hiddenNeurons, setHiddenNeurons] = useState<string[]>([]);
  const [neuronColors, setNeuronColors] = useState<Record<string, string>>({});
  const [seriesMode, setSeriesMode] = useState<BuzzdetectSeriesMode>('activation');
  const [binWidthOverride, setBinWidthOverride] = useState<number | null>(null);
  const [height, setHeight] = useState(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
  const [selection, setSelection] = useState<Selection | null>(null);

  // No spectrogram is driving the viewport here, so fit the whole track to the
  // panel's plot area and keep it fitted as the guide window resizes.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const fit = () => {
      const plotWidth = Math.max(1, el.clientWidth - Y_AXIS_WIDTH);
      viewport.set({ scrollLeft: 0, pixelsPerSecond: plotWidth / DEMO_DURATION, containerWidth: plotWidth });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport]);

  return (
    <div ref={areaRef} className="w-full rounded border border-slate-700 overflow-hidden">
      <BuzzdetectPanel
        data={data}
        viewportStore={viewport}
        duration={DEMO_DURATION}
        currentTimeStore={time}
        selection={selection}
        timeDisplayUnit="seconds"
        thresholds={thresholds}
        hiddenNeurons={hiddenNeurons}
        neuronColors={neuronColors}
        seriesMode={seriesMode}
        binWidthOverride={binWidthOverride}
        height={height}
        onThresholdChange={(neuron, value) => setThresholds(t => ({ ...t, [neuron]: value }))}
        onToggleNeuron={(neuron, hidden) => setHiddenNeurons(list =>
          hidden ? [...list, neuron] : list.filter(n => n !== neuron))}
        onNeuronColorChange={(neuron, color) => setNeuronColors(c => ({ ...c, [neuron]: color }))}
        onSeriesModeChange={setSeriesMode}
        onBinWidthOverrideChange={setBinWidthOverride}
        onHeightChange={setHeight}
        onSelectionChange={setSelection}
        onBoundAnnotationChange={() => {}}
        onSeek={t => time.set(t)}
      />
    </div>
  );
}
