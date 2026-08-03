import { useEffect, useRef, useState } from 'react';
import { BuzzdetectSeriesMode, Selection } from '../../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT, Y_AXIS_WIDTH } from '../../constants';
import { createCurrentTimeStore } from '../../utils/currentTimeStore';
import { createViewportStore } from '../../utils/viewportStore';
import {
  DEMO_DURATION,
  DEMO_ROOT,
  DEMO_TRACK,
  demoAnnotatedTracks,
  demoFiles,
  demoNonMediaFiles,
  makeDemoBuzzdetectData,
} from '../../utils/demoProject';
import BuzzdetectPanel from '../BuzzdetectPanel';
import FileTree from '../FileTree';

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
