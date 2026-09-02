import { useCallback, useEffect, useRef, useState } from 'react';
import { AnnotationTool, BandPassFilter, Selection, SpectrogramSettings } from '../types';
import type { FileFilter } from '../components/controls/FilePanelHeaderButtons';
import { CurrentTimeStore, createCurrentTimeStore } from './currentTimeStore';
import { TimeDisplayUnit } from './helpers';
import type { DateTimeFormat } from './datetimeDisplay';

// Live control mirroring between the main window and the help guide window.
//
// The guide documents the toolbar, so it embeds the real toolbar controls
// (components/controls/*) rather than pictures of them. Those controls are
// pure — state in, callbacks out — so making them live across a window
// boundary is a matter of shipping the state one way and the callbacks the
// other. Same BroadcastChannel approach as utils/helpChannel.ts.
//
// Traffic:
//   client -> host   'hello'   heartbeat; also the request for a full snapshot
//   host   -> client 'state'   the snapshot, on change and in reply to hello
//   host   -> client 'time'    playhead position, throttled, only while connected
//   client -> host   'action'  a control was driven in the guide

/** Everything the embedded controls need to render. Must stay serializable. */
export interface LiveSnapshot {
  /** False when no track is loaded — the controls render disabled. */
  hasTrack: boolean;
  /**
   * The SOURCE duration — the length of the file, not of the (possibly subset)
   * display axis. Everything crossing this bridge is in source time: the guide
   * shows the same file positions the toolbar does, and the host converts at
   * its own edge, where the timeline lives. A timeline can have thousands of
   * spans, and the snapshot is stringified on every host render, so it is
   * deliberately NOT shipped.
   */
  duration: number;
  isPlaying: boolean;
  isBuffering: boolean;
  volume: number;
  muted: boolean;
  playbackSpeed: number;
  lastDefinedSpeed: number;
  speedMin: number;
  speedMax: number;
  /** In source time, like every other time here. */
  selection: Selection | null;
  /** The unit actually in force — already resolved through effectiveTimeUnit. */
  timeDisplayUnit: TimeDisplayUnit;
  /** The unit the user picked, which may be 'datetime' on a startless track. */
  selectedTimeDisplayUnit: TimeDisplayUnit;
  /**
   * Wall-clock start of the track as epoch milliseconds, or null when its
   * filename carries no parseable timestamp. Milliseconds rather than a Date
   * so the snapshot stays plainly serializable (see the equality check in
   * useLiveHost, which stringifies it).
   */
  trackStartMs: number | null;
  dateTimeFormat: DateTimeFormat;
  canGoPrevAnnotation: boolean;
  canGoNextAnnotation: boolean;
  playheadLocked: boolean;
  filterToolActive: boolean;
  filterUnavailable: boolean;
  filterEnabled: boolean;
  filterStrength: number;
  bandPassFilter: BandPassFilter | null;
  buzzdetectAvailable: boolean;
  buzzdetectEnabled: boolean;
  /** Whether any neuron has a Subset at value — gates the scissors button. */
  subsetAvailable: boolean;
  subsetActive: boolean;
  /** Whether any neuron is isolated — gates the isolate button, as above. */
  isolateAvailable: boolean;
  isolateActive: boolean;
  spectrogramSettings: SpectrogramSettings;
  /** Whether the settings popover is open in the main window. */
  spectrogramSettingsOpen: boolean;
  /** Sample rate of the current track — its nyquist limit is the reset target for the frequency max field. */
  sampleRate: number;
  /**
   * File panel state, or null in single-file mode — there is no file panel to
   * drive there, so the guide's copy of those buttons falls back to its demo.
   */
  filePanel: { fileFilter: FileFilter; shuffleMode: boolean; anyExpanded: boolean } | null;
  /** Annotation tools, or null in single-file mode (no tool palette). */
  toolPalette: { tools: AnnotationTool[]; activeToolKey: string | null; playingExampleToolId: string | null } | null;
}

/**
 * What the guide can drive. One method per control callback — the host wires
 * these to the same handlers the toolbar uses, so a control behaves identically
 * in both places.
 */
export interface LiveHandlers {
  play(): void;
  /** `time` is a source time; the host maps it onto the display axis. */
  seek(time: number, scroll?: boolean): void;
  skipToStart(): void;
  skipToEnd(): void;
  prevAnnotation(): void;
  nextAnnotation(): void;
  togglePlayheadLock(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setPlaybackSpeed(speed: number): void;
  setLastDefinedSpeed(speed: number): void;
  setTimeDisplayUnit(unit: TimeDisplayUnit): void;
  /** In source time; the host projects it back onto the display axis. */
  setSelection(selection: Selection): void;
  toggleFilterTool(): void;
  setFilterStrength(strength: number): void;
  enableFilter(strength: number): void;
  disableFilter(): void;
  toggleBuzzdetect(): void;
  toggleSubset(): void;
  toggleIsolate(): void;
  toggleSpectrogramSettings(): void;
  setSpectrogramSettings(patch: Partial<SpectrogramSettings>): void;
  // File panel. No-ops in single-file mode, which publishes `filePanel: null`
  // and so never gets a live copy of these buttons in the first place.
  toggleFileExpandCollapse(): void;
  toggleFileFilter(): void;
  toggleShuffle(): void;
  // Tool palette. The ones that open a modal do so in the main window.
  activateTool(key: string): void;
  activateSelectMode(): void;
  openToolSettings(): void;
  openFindLabel(): void;
  editTool(index: number): void;
  requestDeleteTool(index: number): void;
  playExample(toolId: string): void;
  showExamples(index: number): void;
}

type ActionMessage = {
  [K in keyof LiveHandlers]: { type: 'action'; name: K; args: Parameters<LiveHandlers[K]> }
}[keyof LiveHandlers];

type LiveMessage =
  | { type: 'hello' }
  | { type: 'state'; snapshot: LiveSnapshot }
  | { type: 'time'; t: number }
  | ActionMessage;

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('seenote-live') : null;

function post(msg: LiveMessage): void {
  channel?.postMessage(msg);
}

function subscribe(handler: (msg: LiveMessage) => void): () => void {
  if (!channel) return () => {};
  const listener = (e: MessageEvent) => handler(e.data as LiveMessage);
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

/** Client heartbeat period. The host treats 2.5x this as "gone". */
const HELLO_MS = 2000;
const PRESENCE_TIMEOUT_MS = 5000;
/** Playhead updates are ~50/s at the source; 20/s is plenty for a readout. */
const TIME_THROTTLE_MS = 50;

/**
 * Main-window half of the bridge. Publishes `snapshot` whenever it changes and
 * dispatches inbound actions to `handlers`.
 *
 * Nothing is published while no guide window is listening, so the cost when
 * help is closed is one equality check per render.
 */
export function useLiveHost(
  snapshot: LiveSnapshot,
  handlers: LiveHandlers,
  currentTimeStore: CurrentTimeStore,
  /** Display → source for the playhead. Omit where the two are the same. */
  toSourceTime?: (t: number) => number,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const toSourceRef = useRef(toSourceTime);
  toSourceRef.current = toSourceTime;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const lastSentRef = useRef<string | null>(null);
  const lastHelloRef = useRef(0);
  const lastTimePostRef = useRef(0);

  const connected = () => Date.now() - lastHelloRef.current < PRESENCE_TIMEOUT_MS;

  const publish = (force: boolean) => {
    const serialized = JSON.stringify(snapshotRef.current);
    if (!force && serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    post({ type: 'state', snapshot: snapshotRef.current });
  };

  useEffect(() => subscribe(msg => {
    if (msg.type === 'hello') {
      lastHelloRef.current = Date.now();
      // Always answer with a full snapshot: this doubles as the host's own
      // heartbeat, which is how the client notices the main window went away.
      publish(true);
      return;
    }
    if (msg.type === 'action') {
      // Cast is safe by construction — ActionMessage pairs each name with its
      // own handler's parameters; TypeScript can't see that through the union.
      const fn = handlersRef.current[msg.name] as (...args: unknown[]) => void;
      fn?.(...msg.args);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Publish on change. Runs every render of the host; the equality check keeps
  // that to a JSON.stringify of ~20 scalars, and only while a guide is open.
  useEffect(() => {
    if (connected()) publish(false);
  });

  // Playhead ticks ride their own throttled message so the readout in the guide
  // counts up without re-serializing the whole snapshot 50 times a second.
  useEffect(() => currentTimeStore.subscribe(() => {
    if (!connected()) return;
    const now = Date.now();
    if (now - lastTimePostRef.current < TIME_THROTTLE_MS) return;
    lastTimePostRef.current = now;
    const t = currentTimeStore.get();
    post({ type: 'time', t: toSourceRef.current ? toSourceRef.current(t) : t });
  }), [currentTimeStore]);
}

export interface LiveClient {
  /** Null when no main window is publishing — the guide falls back to a demo. */
  state: LiveSnapshot | null;
  /** Mirrors the host's playhead, in source time. */
  currentTimeStore: CurrentTimeStore;
  call: <K extends keyof LiveHandlers>(name: K, ...args: Parameters<LiveHandlers[K]>) => void;
}

/**
 * Guide-window half of the bridge. Heartbeats, mirrors the snapshot and
 * playhead, and sends actions back.
 */
export function useLiveClient(): LiveClient {
  const [state, setState] = useState<LiveSnapshot | null>(null);
  const storeRef = useRef<CurrentTimeStore | null>(null);
  if (!storeRef.current) storeRef.current = createCurrentTimeStore();
  const lastStateRef = useRef(0);

  useEffect(() => subscribe(msg => {
    if (msg.type === 'state') {
      lastStateRef.current = Date.now();
      setState(msg.snapshot);
    } else if (msg.type === 'time') {
      storeRef.current?.set(msg.t);
    }
  }), []);

  useEffect(() => {
    post({ type: 'hello' });
    const id = setInterval(() => {
      post({ type: 'hello' });
      // Every hello is answered with a snapshot, so silence across more than one
      // round trip means the main window closed or stopped responding.
      if (lastStateRef.current && Date.now() - lastStateRef.current > HELLO_MS * 3) {
        lastStateRef.current = 0;
        setState(null);
      }
    }, HELLO_MS);
    return () => clearInterval(id);
  }, []);

  const call = useCallback(<K extends keyof LiveHandlers>(name: K, ...args: Parameters<LiveHandlers[K]>) => {
    post({ type: 'action', name, args } as ActionMessage);
  }, []);

  return { state, currentTimeStore: storeRef.current, call };
}
