import { useState, useRef, useEffect, useCallback } from 'react';
import { Project, ProjectPreferences } from '../types';
import { shuffleArray } from '../utils/helpers';

interface UseFileNavigationArgs {
  projectRef: React.MutableRefObject<Project>;
  updateProjectPreferences: (id: string, preferences: ProjectPreferences) => Promise<Project | undefined>;
}

// Owns the loaded-track model: path/name/src, current directory, audio-vs-video,
// sample rate, duration, the full media list, shuffle state, and the processing
// flag — plus the mirror refs that defeat stale closures in async callbacks and
// the once-mounted engine closures (trackPathRef, videoSrcRef, isAudioTrackRef,
// durationRef). Exposes the shuffle toggle. The track-open orchestration
// (handleOpenTrack) and queue-aware navigation (navigateFile / displayQueue)
// stay in AnnotationWindow: they are the coordination seam that touches the
// frame source, transport, cache, and annotation reset all at once.
export function useFileNavigation({
  projectRef,
  updateProjectPreferences,
}: UseFileNavigationArgs) {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [trackName, setTrackName] = useState<string>("video");
  const [trackPath, setTrackPath] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [isAudioTrack, setIsAudioTrack] = useState(false);
  const [sampleRate, setSampleRate] = useState(44100);
  const [duration, setDuration] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [allTracks, setAllMediaFiles] = useState<string[]>([]);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [shuffledFiles, setShuffledFiles] = useState<string[]>([]);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Mirror of videoSrc for the synchronous transport predicate.
  const videoSrcRef = useRef<string | null>(null);
  useEffect(() => { videoSrcRef.current = videoSrc; }, [videoSrc]);

  // Ref so the once-mounted onEnded closure / hotkeys read the current value.
  const isAudioTrackRef = useRef(false);
  useEffect(() => { isAudioTrackRef.current = isAudioTrack; }, [isAudioTrack]);

  // Keep trackPathRef in sync so async callbacks can guard against stale closures.
  // (preZoomExtentRef reset on track change is handled by the orchestrator effect
  // that owns that ref; here we only mirror the path.)
  const trackPathRef = useRef<string | null>(null);
  useEffect(() => { trackPathRef.current = trackPath; }, [trackPath]);

  // Toggle shuffle: randomise current allTracks order
  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      const next = !prev;
      if (next) {
        const shuffled = shuffleArray(allTracks);
        // Pin the currently open file at the front of the queue
        const cur = trackPathRef.current;
        if (cur) {
          const idx = shuffled.indexOf(cur);
          if (idx > 0) { shuffled.splice(idx, 1); shuffled.unshift(cur); }
        }
        setShuffledFiles(shuffled);
      }
      if (projectRef.current) {
        updateProjectPreferences(projectRef.current.id, { ...projectRef.current.preferences, shuffleMode: next });
      }
      return next;
    });
  }, [allTracks, updateProjectPreferences, projectRef]);

  return {
    // state + setters
    videoSrc, setVideoSrc,
    trackName, setTrackName,
    trackPath, setTrackPath,
    currentDirectory, setCurrentDirectory,
    isAudioTrack, setIsAudioTrack,
    sampleRate, setSampleRate,
    duration, setDuration,
    isProcessing, setIsProcessing,
    allTracks, setAllMediaFiles,
    shuffleMode, setShuffleMode,
    shuffledFiles, setShuffledFiles,
    // mirror refs
    durationRef,
    videoSrcRef,
    isAudioTrackRef,
    trackPathRef,
    // handlers
    toggleShuffle,
  };
}
