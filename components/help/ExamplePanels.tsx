import { useEffect, useMemo, useRef, useState } from 'react';
import { BuzzdetectSeriesMode, Selection } from '../../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT, DEFAULT_BUZZDETECT_MIN_DETECTION_RATE, DEFAULT_BUZZDETECT_SUBSET_BUFFER, Y_AXIS_WIDTH } from '../../constants';
import { createCurrentTimeStore } from '../../utils/currentTimeStore';
import { createViewportStore } from '../../utils/viewportStore';
import {
  DEMO_DURATION,
  DEMO_IDENT,
  DEMO_ROOT,
  DEMO_TRACK,
  demoAnnotatedTracks,
  demoAnnotations,
  demoAnnotationTools,
  demoFiles,
  demoNonMediaFiles,
  makeDemoBuzzdetectData,
  DEMO_BIN_WIDTH,
  DEMO_NEURONS,
  DEMO_THRESHOLD,
} from '../../utils/demoProject';
import { subsetBuzzdetectData, subsetCriteriaFrom, subsetTimelineFor } from '../../utils/buzzdetectSubset';
import { help } from '../../copy/help';
import BuzzdetectPanel from '../BuzzdetectPanel';
import FileTree from '../FileTree';
import FindLabelPanel, { RenameScope } from '../FindLabelPanel';

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
        isScanning={false}
        allFiles={files}
        allFilesUnfiltered={demoFiles}
        currentTrack={currentTrack}
        onFileSelect={setCurrentTrack}
        collapsed={false}
        onToggleCollapse={() => {}}
        sectionCollapsed={false}
        onToggleSectionCollapsed={() => {}}
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
        nonMediaFiles={demoNonMediaFiles}
        filenameTimeInfo={{ pattern: '', dateTimeFormat: 'friendly' }}
      />
    </div>
  );
}

/** Re-opens a dismissed example panel — nothing else would bring it back. */
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
 * The Find & Rename dock over the example project's annotations. The real dock
 * searches every track on disk and overlays the open track's in-memory
 * annotations; the example project has one track and no annotation files to
 * read, so the search only ever finds the in-memory ones.
 */
export function ExampleFindLabel() {
  const [annotations, setAnnotations] = useState(demoAnnotations);
  const [open, setOpen] = useState(true);
  const [useRegex, setUseRegex] = useState(false);
  const [partial, setPartial] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<RenameScope>('track');

  return (
    <div className="relative w-60 h-[26rem] rounded border border-slate-700 bg-slate-900 overflow-hidden">
      {open ? (
        <FindLabelPanel
          annotations={annotations}
          annotationTools={demoAnnotationTools}
          allTracks={[DEMO_TRACK]}
          trackPath={DEMO_TRACK}
          folderPath={null}
          annotationsLoaded
          getAnnotationPath={() => null}
          getIdent={() => DEMO_IDENT}
          useRegex={useRegex}
          onUseRegexChange={setUseRegex}
          partial={partial}
          onPartialChange={setPartial}
          caseSensitive={caseSensitive}
          onCaseSensitiveChange={setCaseSensitive}
          query={query}
          onQueryChange={setQuery}
          scope={scope}
          onScopeChange={setScope}
          focusNonce={0}
          reloadNonce={0}
          onClose={() => setOpen(false)}
          onGo={() => {}}
          onRename={async (matcher, newText) => {
            const hits = annotations.filter(a => matcher(a.text));
            setAnnotations(list => list.map(a => (matcher(a.text) ? { ...a, text: newText } : a)));
            return hits.length;
          }}
          onRenameSelected={async (_trackFilePath, match, newText) => {
            let renamed = false;
            setAnnotations(list => list.map(a => {
              if (renamed || a.text !== match.label || a.start !== match.start || a.end !== match.end) return a;
              renamed = true;
              return { ...a, text: newText };
            }));
            return renamed;
          }}
        />
      ) : (
        <ReopenButton label={help.live.reopen} onClick={() => setOpen(true)} />
      )}
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

  const [thresholds, setThresholds] = useState<Record<string, number>>(
    () => Object.fromEntries(DEMO_NEURONS.map(n => [n, DEMO_THRESHOLD])));
  const [hiddenNeurons, setHiddenNeurons] = useState<string[]>([]);
  const [neuronColors, setNeuronColors] = useState<Record<string, string>>({});
  const [seriesMode, setSeriesMode] = useState<BuzzdetectSeriesMode>('activation');
  const [binWidthOverride, setBinWidthOverride] = useState<number | null>(null);
  const [height, setHeight] = useState(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
  const [selection, setSelection] = useState<Selection | null>(null);
  // Subset picks ARE the subset thresholds, exactly as in the app: a neuron
  // with an entry here is one the example track is cut by.
  const [subsetThresholds, setSubsetThresholds] = useState<Record<string, number>>({});
  const [minDetectionRate, setMinDetectionRate] = useState(DEFAULT_BUZZDETECT_MIN_DETECTION_RATE);

  // Subsetting for real, through the same two calls the annotation window
  // makes: give a neuron a Subset at value here and the example track genuinely
  // collapses to those detections. The panel is handed the re-expressed data,
  // so — exactly as in the app — it plots the subset without knowing one exists.
  const timeline = useMemo(() => subsetTimelineFor(
    data,
    subsetCriteriaFrom({
      enabled: true,
      subsetThresholds,
      thresholds,
      mode: seriesMode,
      minDetectionRate,
      binWidthOverride,
      frameHop: DEMO_BIN_WIDTH,
      buffer: DEFAULT_BUZZDETECT_SUBSET_BUFFER,
      availableNeurons: DEMO_NEURONS,
    }),
    DEMO_DURATION,
  ), [data, subsetThresholds, thresholds, seriesMode, minDetectionRate, binWidthOverride]);
  const shownData = useMemo(() => subsetBuzzdetectData(data, timeline), [data, timeline]);
  const subsetActive = Object.keys(subsetThresholds).length > 0;

  // No spectrogram is driving the viewport here, so fit the whole track to the
  // panel's plot area and keep it fitted as the guide window resizes. Under a
  // subset the axis is only as long as what was kept, so the fit follows it.
  const displayDuration = timeline.duration;
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const fit = () => {
      const plotWidth = Math.max(1, el.clientWidth - Y_AXIS_WIDTH);
      viewport.set({
        scrollLeft: 0,
        pixelsPerSecond: plotWidth / Math.max(displayDuration, 1e-6),
        containerWidth: plotWidth,
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport, displayDuration]);

  // A selection made before the subset changed names time that may no longer be
  // on the axis; drop it rather than leave a region pointing at nothing.
  useEffect(() => { setSelection(null); }, [timeline]);

  return (
    <div ref={areaRef} className="w-full rounded border border-slate-700 overflow-hidden">
      <BuzzdetectPanel
        data={shownData}
        viewportStore={viewport}
        duration={displayDuration}
        currentTimeStore={time}
        selection={selection}
        timeDisplayUnit="seconds"
        thresholds={thresholds}
        hiddenNeurons={hiddenNeurons}
        neuronColors={neuronColors}
        seriesMode={seriesMode}
        binWidthOverride={binWidthOverride}
        subsetActive={subsetActive}
        timeline={timeline}
        yAxisOverride={null}
        reportAutoValues={false}
        height={height}
        onAutoBinWidthChange={() => {}}
        onAutoYRangeChange={() => {}}
        onHeightChange={setHeight}
        onSelectionChange={setSelection}
        onBoundAnnotationChange={() => {}}
        onSeek={t => time.set(t)}
      />
    </div>
  );
}
