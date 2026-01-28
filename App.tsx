import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Play, Pause, Download, Settings, Loader2, Volume2, VolumeX, Keyboard, ChevronDown, Plus, X, AlertCircle, HelpCircle, AudioWaveform, Bug, Pencil } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import Spectrogram from './components/Spectrogram';
import { Label, SpectrogramSettings, LabelConfig, FrequencyScale } from './types';
import { generateSpectrogramData } from './utils/audioProcessing';
import { DEFAULT_ZOOM_SEC, MAX_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_LABEL_CONFIGS, HOTKEY_COLORS } from './constants';
import { formatTime, exportToCSV, exportToAudacity, exportToJSON } from './utils/helpers';

export default function App() {
  // Media State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>("video");
  const [isAudioFile, setIsAudioFile] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [specData, setSpecData] = useState<{ data: Uint8Array; width: number; height: number; sampleRate: number } | null>(null);
  const [spectrogramError, setSpectrogramError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Volume: 0 to 4 (400% or +12dB approx)
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Annotation State
  const [labels, setLabels] = useState<Label[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [labelConfigs, setLabelConfigs] = useState<LabelConfig[]>(DEFAULT_LABEL_CONFIGS);
  const [activeLabelIndex, setActiveLabelIndex] = useState(0); // 0 is Default

  // Label Editing State
  const [editingLabelIndex, setEditingLabelIndex] = useState<number | null>(null);
  const [editingLabelText, setEditingLabelText] = useState("");
  
  // UI State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5); 
  const [showSettings, setShowSettings] = useState(false);
  const [showHotkeysHelp, setShowHotkeysHelp] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv' | 'txt'>('txt'); // Default to Audacity (txt)
  const [isAddingLabel, setIsAddingLabel] = useState(false);
  const [newLabelText, setNewLabelText] = useState("");
  
  const [settings, setSettings] = useState<SpectrogramSettings>({
      minFreq: 0,
      maxFreq: 22050,
      intensity: 0.7, // Lower default intensity
      contrast: 1.0, // Default contrast
      fftSize: 1024,
      windowSize: DEFAULT_ZOOM_SEC,
      frequencyScale: 'linear' // Default scale
  });

  const addLog = (msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  };

  // Smooth Scrolling Logic via RequestAnimationFrame
  useEffect(() => {
    let rAF: number;
    const loop = () => {
        if (videoRef.current && !videoRef.current.paused) {
            setCurrentTime(videoRef.current.currentTime);
            rAF = requestAnimationFrame(loop);
        }
    };
    
    if (isPlaying) {
        loop();
    }
    
    return () => {
        if (rAF) cancelAnimationFrame(rAF);
    };
  }, [isPlaying]);

  // Handle File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (videoSrc) URL.revokeObjectURL(videoSrc);
    setLabels([]);
    setAudioBuffer(null);
    setSpecData(null);
    setSpectrogramError(null);
    setIsPlaying(false);
    setSelectedLabelId(null);
    setDebugLogs([]); // Clear logs on new file

    const isAudio = file.type.startsWith('audio/');
    setIsAudioFile(isAudio);
    setVideoFileName(file.name);
    addLog(`Loading file: ${file.name} (${file.type})`);

    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setIsProcessing(true);

    try {
        const arrayBuffer = await file.arrayBuffer();
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        const audioContext = new AudioContext();
        
        // Use promise-based decode if available, fallback for older safety
        const decodedBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
            audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        });

        setAudioBuffer(decodedBuffer);
        addLog(`Audio decoded. Duration: ${decodedBuffer.duration.toFixed(2)}s, SampleRate: ${decodedBuffer.sampleRate}`);
        
        // Update maxFreq to Nyquist
        setSettings(s => ({ ...s, maxFreq: decodedBuffer.sampleRate / 2 }));
        
        // Generate Spectrogram
        addLog("Generating Spectrogram...");
        const data = await generateSpectrogramData(decodedBuffer, settings.fftSize);
        setSpecData(data);
        addLog("Spectrogram generated successfully.");
    } catch (err) {
        console.warn("Audio decoding failed.", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`Spectrogram failed: ${errMsg}`, 'error');
        setSpectrogramError("Spectrogram unavailable for this format");
    } finally {
        setIsProcessing(false);
    }
  };

  const togglePlay = useCallback(() => {
      if (videoRef.current) {
          if (isPlaying) videoRef.current.pause();
          else videoRef.current.play();
          setIsPlaying(!isPlaying);
      }
  }, [isPlaying]);

  const seek = useCallback((time: number) => {
      if (videoRef.current) {
          videoRef.current.currentTime = time;
          setCurrentTime(time);
      }
  }, []);

  // Global Hotkeys
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;

          switch(e.key.toLowerCase()) {
              case ' ':
                  e.preventDefault();
                  togglePlay();
                  break;
              case 'm':
                  setMuted(prev => !prev);
                  break;
              case 'delete':
              case 'backspace':
                  if (selectedLabelId) {
                      setLabels(prev => prev.filter(l => l.id !== selectedLabelId));
                      setSelectedLabelId(null);
                  }
                  break;
          }

          // Hotkey Numbers (0-9) - Set Active Label Index
          if (/^[0-9]$/.test(e.key)) {
              const idx = parseInt(e.key);
              if (idx < labelConfigs.length) {
                  setActiveLabelIndex(idx);
              }
          }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, selectedLabelId, labelConfigs]);

  const performExport = async () => {
      if (labels.length === 0) return;
      if (exportFormat === 'json') {
          await exportToJSON(labels, videoFileName);
      } else if (exportFormat === 'csv') {
          await exportToCSV(labels, videoFileName);
      } else if (exportFormat === 'txt') {
          await exportToAudacity(labels, videoFileName);
      }
      addLog(`Exported annotations as ${exportFormat.toUpperCase()}`);
  };

  const handleAddLabelConfig = () => {
      if (newLabelText.trim() === "") {
          setIsAddingLabel(false);
          return;
      }
      
      const nextIndex = labelConfigs.length;
      if (nextIndex >= 10) {
          alert("Maximum of 10 hotkey labels (0-9) allowed.");
          setIsAddingLabel(false);
          setNewLabelText("");
          return;
      }
      
      const newConfig: LabelConfig = {
          key: nextIndex.toString(),
          text: newLabelText,
          color: HOTKEY_COLORS[nextIndex]
      };
      
      setLabelConfigs([...labelConfigs, newConfig]);
      setIsAddingLabel(false);
      setNewLabelText("");
      // Auto-select the newly created label config
      setActiveLabelIndex(nextIndex);
      addLog(`Added category: ${newLabelText} (${nextIndex})`);
  };

  const startEditingCategory = (idx: number) => {
      setEditingLabelIndex(idx);
      setEditingLabelText(labelConfigs[idx].text);
  };

  const saveEditingCategory = () => {
      if (editingLabelIndex === null) return;
      
      const idx = editingLabelIndex;
      const config = labelConfigs[idx];
      const newName = editingLabelText.trim();
      
      if (newName && newName !== config.text) {
          // Update Config
          const updatedConfigs = [...labelConfigs];
          updatedConfigs[idx] = { ...config, text: newName };
          setLabelConfigs(updatedConfigs);

          // Update ALL labels with this configId
          const updatedLabels = labels.map(l => {
              if (l.configId === config.key) {
                  return { ...l, text: newName };
              }
              return l;
          });
          setLabels(updatedLabels);
          addLog(`Renamed category ${config.text} -> ${newName}. Updated linked events.`);
      }

      setEditingLabelIndex(null);
      setEditingLabelText("");
  };

  const handleDeleteCategory = (idx: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (idx === 0) return; // Cannot delete Custom Label

      const config = labelConfigs[idx];
      const linkedLabels = labels.filter(l => l.configId === config.key);
      
      if (linkedLabels.length > 0) {
          // Prompt
          const choice = confirm(
              `Deleting category "${config.text}" which is used by ${linkedLabels.length} events.\n\n` +
              `OK: Convert events to Custom Labels (White)\n` +
              `Cancel: Delete all ${linkedLabels.length} events`
          );
          
          if (choice) {
              // Convert
              const updatedLabels = labels.map(l => {
                  if (l.configId === config.key) {
                      return { ...l, configId: "0", color: "#ffffff" };
                  }
                  return l;
              });
              setLabels(updatedLabels);
              addLog(`Deleted category ${config.text}. Converted events to Custom.`);
          } else {
              // Delete
              const updatedLabels = labels.filter(l => l.configId !== config.key);
              setLabels(updatedLabels);
              addLog(`Deleted category ${config.text} and all linked events.`);
          }
      } else {
          addLog(`Deleted category ${config.text} (unused).`);
      }

      // Remove Config
      const newConfigs = labelConfigs.filter((_, i) => i !== idx);
      // Re-index keys? No, keeping keys stable is safer for now, but UI shows 0-9. 
      // Re-indexing is expected behavior for "Hotkeys 0-9".
      const reindexed = newConfigs.map((c, i) => ({ ...c, key: i.toString(), color: HOTKEY_COLORS[i] }));
      
      setLabelConfigs(reindexed);
      setActiveLabelIndex(0);
  };

  const handleSplitDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = splitRatio;
      
      const onMove = (moveEvent: MouseEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64; 
          const newRatio = Math.max(0.2, Math.min(0.8, startRatio + (delta / totalHeight)));
          setSplitRatio(newRatio);
      };
      
      const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  // Handle volume slider change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = parseFloat(e.target.value);
      // Snap to 1.0 if close
      if (val > 0.95 && val < 1.05) val = 1.0;
      setVolume(val);
      setMuted(false);
  };

  // Calculate volume slider background
  const volPercent = Math.min(100, (volume / 4) * 100); 
  const isBoosted = volume > 1;

  // Format label for display in dropdown
  const getFormatLabel = (fmt: string) => {
      if (fmt === 'txt') return 'Audacity';
      return fmt.toUpperCase();
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200" onClick={() => setShowExportMenu(false)}>
      {/* Header */}
      <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative">
        <div className="flex items-center space-x-4">
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r
  from-[#e65161]
  to-[rgb(249,195,135)]">
                SeeNote
            </h1>
            <div className="h-6 w-px bg-slate-600 mx-2" />
            <label className="flex items-center space-x-2 cursor-pointer hover:bg-slate-700 px-3 py-1.5 rounded transition-colors">
                <Upload size={18} />
                <span className="text-sm">Open Media</span>
                <input 
                    type="file" 
                    // Support Video AND Audio
                    accept="video/*,audio/*,.mkv" 
                    onChange={handleFileUpload} 
                    className="hidden" 
                />
            </label>
        </div>

        <div className="flex items-center space-x-4">
            <div className="text-mono text-lg font-medium w-24 text-center">
                {formatTime(currentTime)}
            </div>
            <div className="flex items-center space-x-2">
                 <button 
                    onClick={togglePlay}
                    disabled={!videoSrc}
                    className="p-2 rounded-full bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 text-white transition-all shadow-lg"
                >
                    {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
                </button>
            </div>
            
            {/* Volume Control */}
            <div className="flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-1 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600">
                <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
                    {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <div className="relative w-24 h-5 flex items-center">
                    <input 
                        type="range" min="0" max="4" step="0.05"
                        value={muted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className={`w-full h-1 bg-slate-500 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${isBoosted ? '[&::-webkit-slider-thumb]:bg-red-500' : '[&::-webkit-slider-thumb]:bg-[#e65161]'}`}
                        style={{
                            background: `linear-gradient(to right, ${isBoosted ? '#ef4444' : '#e65161'} 0%, ${isBoosted ? '#ef4444' : '#e65161'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(volume / 4) * 100}%, #64748b ${(volume / 4) * 100}%, #64748b 100%)`
                        }}
                    />
                    {/* Tick for 100% */}
                    <div className="absolute left-[25%] top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none"></div>
                </div>
            </div>
        </div>

        <div className="flex items-center space-x-3">
             <button 
                onClick={() => setShowDebug(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Debug Console"
            >
                <Bug size={18} />
            </button>
             <button 
                onClick={() => setShowHelp(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Help Guide"
            >
                <HelpCircle size={18} />
            </button>
             <button 
                onClick={() => setShowHotkeysHelp(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Keyboard Shortcuts"
            >
                <Keyboard size={18} />
            </button>
            
            <div className="flex items-center space-x-2">
                <div className="relative">
                     <button 
                         onClick={(e) => { e.stopPropagation(); setShowExportMenu(!showExportMenu); }}
                         className="flex items-center space-x-2 px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm border border-slate-600 min-w-[120px] justify-between"
                         title="Select Export Format"
                     >
                        <span className="font-semibold text-[#e65161]">{getFormatLabel(exportFormat)}</span>
                        <ChevronDown size={14} />
                     </button>
                     <span className="text-[10px] text-slate-400 absolute -bottom-4 left-0 w-full text-center">Export Format</span>

                     {showExportMenu && (
                        <div className="absolute top-full right-0 mt-2 w-32 bg-slate-800 border border-slate-700 rounded shadow-xl overflow-hidden z-50">
                            <button onClick={() => { setExportFormat('txt'); setShowExportMenu(false); }} className={`w-full text-left px-4 py-2 hover:bg-slate-700 text-sm flex justify-between ${exportFormat === 'txt' ? 'text-[#e65161]' : ''}`}>
                                Audacity {exportFormat === 'txt' && '✓'}
                            </button>
                            <button onClick={() => { setExportFormat('json'); setShowExportMenu(false); }} className={`w-full text-left px-4 py-2 hover:bg-slate-700 text-sm flex justify-between ${exportFormat === 'json' ? 'text-[#e65161]' : ''}`}>
                                JSON {exportFormat === 'json' && '✓'}
                            </button>
                            <button onClick={() => { setExportFormat('csv'); setShowExportMenu(false); }} className={`w-full text-left px-4 py-2 hover:bg-slate-700 text-sm flex justify-between ${exportFormat === 'csv' ? 'text-[#e65161]' : ''}`}>
                                CSV {exportFormat === 'csv' && '✓'}
                            </button>
                        </div>
                    )}
                </div>

                <button 
                    onClick={performExport}
                    disabled={labels.length === 0}
                    className="p-2 rounded bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 disabled:bg-slate-700 text-white transition-colors"
                    title="Download Annotations"
                >
                    <Download size={20} />
                </button>
            </div>
        </div>
      </header>
      
      {/* Debug Modal */}
      {showDebug && (
          <div 
             className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
             onClick={() => setShowDebug(false)}
          >
              <div 
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-2xl w-full h-[600px] flex flex-col p-6 relative"
                  onClick={(e) => e.stopPropagation()}
              >
                   <div className="flex justify-between items-center mb-4">
                       <h3 className="text-xl font-bold flex items-center gap-2"><Bug size={20} className="text-[#e65161]" /> Debug Console</h3>
                       <button onClick={() => setShowDebug(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                   </div>
                   <div className="flex-1 bg-slate-900 rounded p-4 overflow-y-auto font-mono text-sm border border-slate-700">
                       {debugLogs.length === 0 ? <span className="text-slate-500 italic">No logs yet...</span> : (
                           debugLogs.map((log, i) => (
                               <div key={i} className={`mb-1 ${log.type === 'error' ? 'text-red-400' : 'text-slate-300'}`}>
                                   <span className="text-slate-500 mr-2">[{log.time}]</span>
                                   {log.msg}
                               </div>
                           ))
                       )}
                   </div>
              </div>
          </div>
      )}

      {/* Help Modal */}
      {showHelp && (
        <div 
             className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
             onClick={() => setShowHelp(false)}
        >
             <div 
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-lg w-full p-6 relative"
                  onClick={(e) => e.stopPropagation()}
             >
                  <button 
                    onClick={() => setShowHelp(false)}
                    className="absolute top-4 right-4 text-slate-400 hover:text-white"
                  >
                      <X size={20} />
                  </button>
                  <h3 className="text-xl font-bold mb-4 text-[#e65161]">How to use SeeNote</h3>
                  
                  <div className="space-y-4 text-sm text-slate-300">
                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">1. Get Started</h4>
                      <p>Upload a video or audio file. The app will visualize the spectrogram below.</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">2. Navigation</h4>
                      <p>
                        <span className="text-white">Pan:</span> Right-Click & Drag or use Scroll Wheel.<br/>
                        <span className="text-white">Zoom:</span> Ctrl + Scroll Wheel to zoom in/out of time.<br/>
                        <span className="text-white">Play/Pause:</span> Press Spacebar.
                      </p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">3. Creating Labels</h4>
                      <p>Click and drag anywhere on the spectrogram to create a new label segment. The label will inherit the currently active category (bottom right).</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">4. Managing Categories</h4>
                      <p>Use the panel on the right to add named categories. Press numbers <span className="font-mono bg-slate-700 px-1 rounded">0-9</span> on your keyboard to quickly switch between them.</p>
                      <p>Click a category name to rename it (updates all labels).</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">5. Editing & Deleting</h4>
                      <p>
                        Drag the left/right edges of a label to resize.<br/>
                        Click the label text to rename. <span className="text-orange-400">Note:</span> Renaming a colored label converts it to a generic "Custom Label".<br/>
                        <span className="text-red-400">Middle Click</span> any label to delete it instantly.
                      </p>
                    </div>
                  </div>
             </div>
        </div>
      )}

      {/* Hotkey Help Modal */}
      {showHotkeysHelp && (
          <div 
             className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
             onClick={() => setShowHotkeysHelp(false)}
          >
              <div 
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-sm w-full p-6 relative"
                  onClick={(e) => e.stopPropagation()}
              >
                  <button 
                    onClick={() => setShowHotkeysHelp(false)}
                    className="absolute top-4 right-4 text-slate-400 hover:text-white"
                  >
                      <X size={20} />
                  </button>
                  <h3 className="text-lg font-bold mb-4">Keyboard Shortcuts</h3>
                  <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-400">Space</span> <span>Play / Pause</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">M</span> <span>Mute / Unmute</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Delete / Backspace</span> <span>Delete Selected</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Middle Click</span> <span>Delete Label</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">0 - 9</span> <span>Set Active Label</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Ctrl/Cmd + Scroll</span> <span>Zoom Spectrogram</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Scroll / Right Click</span> <span>Pan Spectrogram</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Escape</span> <span>Exit Label Edit</span></div>
                  </div>
              </div>
          </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Video Pane */}
        <div style={{ height: `${splitRatio * 100}%` }} className="bg-black relative flex">
             <div className="flex-1 relative bg-black flex justify-center items-center">
                 <VideoPlayer 
                    ref={videoRef}
                    src={videoSrc}
                    volume={volume}
                    muted={muted}
                    isAudio={isAudioFile}
                    onTimeUpdate={(t) => {
                        // Only update from event if NOT playing (to avoid jitter with RAF)
                        if (!isPlaying) setCurrentTime(t);
                    }}
                    onDurationChange={setDuration}
                    onLoadedMetadata={() => {}}
                 />
                 {isProcessing && (
                     <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                         <Loader2 className="animate-spin text-[#e65161] mb-2" size={48} />
                         <p className="text-[#e65161] font-medium">Processing Media...</p>
                         <p className="text-slate-400 text-sm mt-1">Generating Spectrogram</p>
                     </div>
                 )}
                 {spectrogramError && !isProcessing && (
                     <div className="absolute top-4 left-4 bg-red-500/90 text-white px-4 py-2 rounded shadow-lg flex items-center space-x-2 z-30 animate-in fade-in slide-in-from-top-4">
                         <AlertCircle size={20} />
                         <span className="text-sm font-medium">{spectrogramError}</span>
                     </div>
                 )}
             </div>

             {/* Right-Side Label Palette Overlay */}
             {/* Adjusted to handle varying label widths and better button placement */}
             <div className="absolute top-4 right-4 bottom-4 w-64 flex flex-col items-end pointer-events-none z-30 space-y-2">
                 {/* Label List */}
                 <div className="w-full flex flex-col items-end space-y-2 pointer-events-auto overflow-y-auto pr-2 custom-scrollbar max-h-full py-2">
                     {labelConfigs.map((cfg, idx) => {
                         const isActive = idx === activeLabelIndex;
                         const isDefault = idx === 0;
                         const isEditing = editingLabelIndex === idx;

                         if (isEditing) {
                            return (
                                <div key={cfg.key} className="flex flex-col items-end animate-in fade-in slide-in-from-right-2 mb-2 bg-slate-800 p-2 rounded border border-slate-600 shadow-xl z-50 w-full max-w-[220px]">
                                    <input 
                                       autoFocus
                                       className="bg-slate-700 text-white text-sm px-2 py-1 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]" 
                                       value={editingLabelText}
                                       onChange={e => setEditingLabelText(e.target.value)}
                                       onKeyDown={(e) => {
                                           if (e.key === 'Enter') saveEditingCategory();
                                           if (e.key === 'Escape') setEditingLabelIndex(null);
                                       }}
                                       onBlur={saveEditingCategory}
                                    />
                                    <span className="text-[10px] text-orange-400 mt-1 w-full text-right font-medium">Renaming updates all matching labels</span>
                                </div>
                            );
                         }

                         return (
                            <div key={cfg.key} className="flex items-center justify-end group/item gap-2 w-full">
                                {/* Buttons container - appear to the left of label */}
                                {!isDefault && (
                                     <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                         <button 
                                            onClick={(e) => handleDeleteCategory(idx, e)}
                                            className="text-red-500 hover:text-red-400 bg-black/80 rounded-full p-1.5 shadow-md hover:scale-110 transition-transform"
                                            title="Delete Category"
                                        >
                                            <X size={14} />
                                        </button>
                                         <button 
                                            onClick={(e) => { e.stopPropagation(); startEditingCategory(idx); }}
                                            className="text-blue-400 hover:text-blue-300 bg-black/80 rounded-full p-1.5 shadow-md hover:scale-110 transition-transform"
                                            title="Rename Category"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                    </div>
                                )}
                                
                                <button
                                    onClick={() => setActiveLabelIndex(idx)}
                                    className={`
                                        relative flex items-center justify-between px-3 py-1.5 rounded-lg transition-all border 
                                        ${isActive ? 'opacity-100 ring-2 ring-white scale-105' : 'opacity-70 hover:opacity-100'}
                                    `}
                                    style={{ 
                                        backgroundColor: cfg.color, 
                                        borderColor: isDefault ? '#4b5563' : cfg.color, 
                                        minWidth: '100px', // Minimum width for touch target
                                        maxWidth: '100%'     // Allow growing based on text
                                    }}
                                >
                                    <span 
                                        className={`text-sm font-medium ${isDefault ? 'text-black' : 'text-white'} truncate text-left mr-2`}
                                        title={isDefault ? "Custom Label" : cfg.text}
                                    >
                                        {cfg.text}
                                    </span>
                                    <span className={`text-xs font-mono opacity-80 ${isDefault ? 'text-black' : 'text-white'}`}>
                                        {cfg.key}
                                    </span>
                                </button>
                            </div>
                         );
                     })}

                     {/* Add Label Button */}
                     {labelConfigs.length < 10 && (
                         <div className="flex items-center justify-end w-full pt-2">
                             {isAddingLabel ? (
                                 <div className="flex items-center bg-slate-800 rounded-full border border-slate-600 p-1 shadow-lg animate-in fade-in slide-in-from-right-4">
                                     <div 
                                        className="w-6 h-6 rounded-full flex items-center justify-center mr-2"
                                        style={{ backgroundColor: HOTKEY_COLORS[labelConfigs.length] }}
                                     >
                                        <span className="text-white text-xs font-bold">{labelConfigs.length}</span>
                                     </div>
                                     <input 
                                        autoFocus
                                        type="text"
                                        className="bg-transparent text-white text-sm outline-none w-24 mr-2"
                                        placeholder="Label Name"
                                        value={newLabelText}
                                        onChange={(e) => setNewLabelText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if(e.key === 'Enter') handleAddLabelConfig();
                                            if(e.key === 'Escape') setIsAddingLabel(false);
                                        }}
                                        onBlur={handleAddLabelConfig}
                                     />
                                 </div>
                             ) : (
                                 <button 
                                    onClick={() => setIsAddingLabel(true)}
                                    className="flex items-center space-x-2 group"
                                 >
                                    <span className="text-slate-400 text-sm font-medium group-hover:text-white transition-colors">Add Label</span>
                                    <div 
                                        className="w-8 h-8 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 shadow-lg"
                                        style={{ backgroundColor: HOTKEY_COLORS[labelConfigs.length] }}
                                    >
                                        <Plus size={16} className="text-white" />
                                    </div>
                                 </button>
                             )}
                         </div>
                     )}
                 </div>
             </div>
        </div>

        {/* Resizer Handle */}
        <div 
            className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
            onMouseDown={handleSplitDrag}
        >
            <div className="w-12 h-1 bg-slate-600 rounded-full" />
        </div>

        {/* Spectrogram Pane */}
        <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="relative bg-slate-900 border-t border-slate-700">
             
             {/* Settings Button (Top Right) */}
             <div className="absolute top-4 right-4 z-50">
                <button 
                    onClick={() => setShowSettings(!showSettings)}
                    className={`p-2 rounded hover:bg-slate-700 ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
                    title="Spectrogram Settings"
                >
                    <Settings size={20} />
                </button>
             </div>

             {/* Settings Panel (Absolute, relative to this pane) */}
             {showSettings && (
                <div className="absolute top-14 right-4 z-40 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <div className="p-4 border-b border-slate-700 flex justify-between items-center sticky top-0 bg-slate-800 z-10">
                        <h3 className="font-semibold text-slate-200 flex items-center gap-2">
                            <AudioWaveform size={16} /> Spectrogram Settings
                        </h3>
                    </div>
                    
                    <div className="p-4 space-y-6">
                        {/* Visuals */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Visuals</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Brightness</label>
                                <input 
                                    type="range" min="0.1" max="2.0" step="0.1"
                                    value={settings.intensity}
                                    onChange={(e) => setSettings({...settings, intensity: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Contrast</label>
                                <input 
                                    type="range" min="0.5" max="2.0" step="0.1"
                                    value={settings.contrast}
                                    onChange={(e) => setSettings({...settings, contrast: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block flex justify-between">
                                    <span>Window Size (Zoom)</span>
                                    <span>{settings.windowSize.toFixed(1)}s</span>
                                </label>
                                <input 
                                    type="range" min={MIN_ZOOM_SEC} max={MAX_ZOOM_SEC} step="1"
                                    value={settings.windowSize}
                                    onChange={(e) => setSettings({...settings, windowSize: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                        </div>

                        {/* Frequency */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Frequency</h4>
                             <div>
                                <label className="text-xs text-slate-400 mb-1 block">Scale</label>
                                <select 
                                    value={settings.frequencyScale}
                                    onChange={(e) => setSettings({...settings, frequencyScale: e.target.value as FrequencyScale})}
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
                                >
                                    <option value="linear">Linear</option>
                                    <option value="log">Logarithmic</option>
                                    <option value="mel">Mel</option>
                                </select>
                            </div>
                            
                            <div className="flex space-x-2 pt-2">
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Min (Hz)</label>
                                    <input 
                                        type="number" 
                                        value={settings.minFreq}
                                        onChange={(e) => setSettings({...settings, minFreq: Math.max(0, parseInt(e.target.value))})}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Max (Hz)</label>
                                    <input 
                                        type="number" 
                                        value={settings.maxFreq}
                                        onChange={(e) => setSettings({...settings, maxFreq: parseInt(e.target.value)})}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
             )}

             <Spectrogram 
                audioBuffer={audioBuffer}
                specData={specData}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                isProcessing={isProcessing}
                settings={settings}
                labels={labels}
                selectedLabelId={selectedLabelId}
                activeLabelConfig={labelConfigs[activeLabelIndex]}
                labelConfigs={labelConfigs}
                onSeek={seek}
                onLabelsChange={setLabels}
                onSelectLabel={setSelectedLabelId}
                onZoomChange={(z) => setSettings(s => ({...s, windowSize: z}))}
             />
             
             {!videoSrc && (
                 <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                     <div className="text-slate-600 text-center">
                         <p className="text-lg font-medium">No Media Loaded</p>
                         <p className="text-sm">Open a video or audio file to begin annotating</p>
                     </div>
                 </div>
             )}
        </div>
      </div>
    </div>
  );
}