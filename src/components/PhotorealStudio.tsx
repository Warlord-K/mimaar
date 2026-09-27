import React, { useEffect, useRef, useState } from 'react';
import { LidarFilterState, LidarMetadata, LidarRenderSettings } from '../types/lidar';
import {
  LegendEntry,
  PhotorealClip,
  PhotorealConfig,
  PhotorealShot,
  ViewportCaptureFn
} from '../types/photoreal';
import { ASPRS_CLASSIFICATIONS } from '../utils/colormaps';
import {
  base64ToBlobUrl,
  fetchPhotorealConfig,
  generateVideo,
  mapWithLimit,
  renderPhoto
} from '../utils/photorealApi';
import {
  AlertCircle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Image as ImageIcon,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';

interface PhotorealStudioProps {
  captureRef: React.MutableRefObject<ViewportCaptureFn | null>;
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  /** Scene hint for the current dataset (preset description); editable by the user. */
  defaultScene: string;
}

const PARALLEL_REQUESTS = 3;
const MAX_SHOTS = 8;

export const PhotorealStudio: React.FC<PhotorealStudioProps> = ({
  captureRef,
  metadata,
  filterState,
  renderSettings,
  defaultScene
}) => {
  const [config, setConfig] = useState<PhotorealConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [shots, setShots] = useState<PhotorealShot[]>([]);
  const shotsRef = useRef<PhotorealShot[]>([]);
  shotsRef.current = shots;
  const shotCounter = useRef(1);

  // Photo settings
  const [scene, setScene] = useState(defaultScene);
  const sceneEdited = useRef(false);
  const [look, setLook] = useState('');
  const [imageSize, setImageSize] = useState('2K');
  const [consistent, setConsistent] = useState(true);
  // Text description of the first rendered photo; every other shot is asked to match it.
  const [anchor, setAnchor] = useState<{ shotId: string; look: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Video settings
  const [motion, setMotion] = useState('');
  const [resolution, setResolution] = useState('720p');
  const [clips, setClips] = useState<PhotorealClip[]>([]);
  const clipsRef = useRef<PhotorealClip[]>([]);
  clipsRef.current = clips;
  const [playIndex, setPlayIndex] = useState(0);

  const [busy, setBusy] = useState<'photos' | 'video' | null>(null);
  const [viewing, setViewing] = useState<PhotorealShot | null>(null);

  useEffect(() => {
    fetchPhotorealConfig()
      .then(setConfig)
      .catch(err => setConfigError(err.message || String(err)));
  }, []);

  useEffect(() => {
    if (!sceneEdited.current) setScene(defaultScene);
  }, [defaultScene]);

  // Release video blob URLs when the panel goes away
  useEffect(() => () => clipsRef.current.forEach(c => c.url && URL.revokeObjectURL(c.url)), []);

  const enabled = !!config?.enabled;
  const photos = shots.filter(s => s.photo);
  const pending = shots.filter(s => s.status !== 'done' && s.status !== 'running');
  const readyClips = clips.filter(c => c.url);

  const updateShot = (id: string, patch: Partial<PhotorealShot>) =>
    setShots(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  const updateClip = (id: string, patch: Partial<PhotorealClip>) =>
    setClips(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));

  const visibleLegend = (): LegendEntry[] =>
    Object.keys(metadata.classCounts)
      .map(Number)
      .filter(code => filterState.enabledClasses.size === 0 || filterState.enabledClasses.has(code))
      .filter(code => ASPRS_CLASSIFICATIONS[code])
      .map(code => ({ name: ASPRS_CLASSIFICATIONS[code].name, hex: ASPRS_CLASSIFICATIONS[code].hex }));

  const handleCapture = () => {
    const capture = captureRef.current?.(1536);
    if (!capture) {
      setNotice('The viewport is not ready yet. Try again in a moment.');
      return;
    }
    setNotice(null);
    const shot: PhotorealShot = {
      id: `shot_${Date.now()}`,
      label: `View ${shotCounter.current++}`,
      capture,
      colorMode: renderSettings.colorMode,
      colormap: renderSettings.colormap,
      legend: renderSettings.colorMode === 'classification' ? visibleLegend() : [],
      status: 'idle'
    };
    setShots(prev => [...prev, shot]);
  };

  const renderShot = async (shot: PhotorealShot, anchorLook: string | undefined, returnLook: boolean) => {
    updateShot(shot.id, { status: 'running', error: undefined });
    try {
      const res = await renderPhoto({
        image: shot.capture.dataUrl,
        width: shot.capture.width,
        height: shot.capture.height,
        colorMode: shot.colorMode,
        colormap: shot.colormap,
        legend: shot.legend,
        scene,
        look,
        imageSize,
        anchorLook,
        returnLook
      });
      updateShot(shot.id, {
        status: 'done',
        photo: { dataUrl: `data:${res.mimeType};base64,${res.image}`, interactionId: res.interactionId }
      });
      if (returnLook) {
        if (res.look) setAnchor({ shotId: shot.id, look: res.look });
        else if (res.lookError) setNotice(`Could not describe the first photo, so shots won't share a look: ${res.lookError}`);
      }
      return res;
    } catch (err: any) {
      updateShot(shot.id, { status: 'error', error: err.message || String(err) });
      return null;
    }
  };

  /** Render every shot without a photo. The first one sets the shared look for the rest. */
  const handleRenderPending = async () => {
    const todo = shotsRef.current.filter(s => s.status !== 'done' && s.status !== 'running');
    if (!todo.length || busy) return;
    setBusy('photos');
    setNotice(null);
    try {
      let rest = todo;
      let anchorLook = consistent ? anchor?.look : undefined;
      if (consistent && !anchorLook) {
        const [first, ...others] = todo;
        rest = others;
        anchorLook = (await renderShot(first, undefined, true))?.look;
      }
      await mapWithLimit(rest, PARALLEL_REQUESTS, s => renderShot(s, anchorLook, false));
    } finally {
      setBusy(null);
    }
  };

  const handleRerender = async (shot: PhotorealShot) => {
    if (busy) return;
    setBusy('photos');
    try {
      const isAnchor = consistent && (!anchor || anchor.shotId === shot.id);
      await renderShot(shot, isAnchor ? undefined : consistent ? anchor?.look : undefined, isAnchor);
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = (shot: PhotorealShot) => {
    setShots(prev => prev.filter(s => s.id !== shot.id));
    if (anchor?.shotId === shot.id) setAnchor(null);
  };

  const handleMove = (shot: PhotorealShot, delta: number) =>
    setShots(prev => {
      const i = prev.findIndex(s => s.id === shot.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /** 1 photo: a clip that starts on it. 2+ photos: a camera move between each consecutive pair. */
  const handleMakeVideo = async () => {
    const done = shotsRef.current.filter(s => s.photo);
    if (!done.length || busy) return;
    clipsRef.current.forEach(c => c.url && URL.revokeObjectURL(c.url));
    const jobs =
      done.length === 1
        ? [{ id: 'clip_0', label: `${done[0].label} clip`, frames: [done[0]] }]
        : done.slice(0, -1).map((s, i) => ({
            id: `move_${i}`,
            label: `${s.label} → ${done[i + 1].label}`,
            frames: [s, done[i + 1]]
          }));
    setClips(jobs.map(j => ({ id: j.id, label: j.label, status: 'running' })));
    setPlayIndex(0);
    setBusy('video');
    try {
      await mapWithLimit(jobs, PARALLEL_REQUESTS, async job => {
        const first = job.frames[0].capture;
        try {
          const res = await generateVideo({
            frames: job.frames.map(f => f.photo!.dataUrl),
            scene,
            motion,
            resolution,
            aspectRatio: first.width >= first.height ? '16:9' : '9:16'
          });
          updateClip(job.id, { status: 'done', url: base64ToBlobUrl(res.video, res.mimeType) });
        } catch (err: any) {
          updateClip(job.id, { status: 'error', error: err.message || String(err) });
        }
      });
    } finally {
      setBusy(null);
    }
  };

  const labelClass = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider';
  const inputClass =
    'w-full bg-[#13141c] border border-[#34384d] rounded-lg px-2.5 py-1.5 text-xs text-gray-200 outline-none placeholder-gray-500 focus:border-[#e87d0d] select-text';
  const primaryButton =
    'w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-[#e87d0d] hover:bg-[#ff8f1c] text-white rounded-lg text-xs font-semibold transition-colors shadow-md disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex flex-col h-full bg-[#181922] border-l border-[#2d3040] text-gray-200 select-none overflow-hidden">
      {/* Header */}
      <div className="p-3 bg-[#1e202b] border-b border-[#2d313e] flex items-center gap-2 shrink-0">
        <div className="p-1.5 bg-[#e87d0d]/15 text-[#e87d0d] rounded-lg">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-bold text-gray-100">Photoreal Studio</span>
            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 rounded border border-emerald-500/20">
              {config?.models.image ?? 'gemini-3.1-flash-image'}
            </span>
            <span className="text-[10px] font-mono text-sky-400 bg-sky-500/10 px-1.5 rounded border border-sky-500/20">
              {config?.models.video ?? 'gemini-omni-1.1-flash'}
            </span>
          </div>
          <div className="text-[10px] text-gray-400">LiDAR view → real photo (Nano Banana 2) → video (Omni)</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
        {(configError || (config && !config.enabled)) && (
          <div className="flex gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-[11px]">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              {configError
                ? `Photoreal service unreachable: ${configError}`
                : 'GEMINI_API_KEY is not set on the server. Add it in the AI Studio Secrets panel (or .env locally) to render.'}
            </span>
          </div>
        )}
        {notice && (
          <div className="flex gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px]">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="text-amber-300/70 hover:text-amber-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 1. Shots */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className={labelClass}>1 · Shots ({shots.length}/{MAX_SHOTS})</span>
            <span className="text-[10px] text-gray-500">Orbit the viewport, then capture</span>
          </div>
          <button
            onClick={handleCapture}
            disabled={shots.length >= MAX_SHOTS}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-[#252838] hover:bg-[#31354a] border border-[#373b52] text-gray-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Capture current view</span>
          </button>

          {shots.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {shots.map((shot, i) => (
                <div key={shot.id} className="bg-[#1e202b] border border-[#2d313e] rounded-lg overflow-hidden">
                  <button
                    onClick={() => setViewing(shot)}
                    className="relative block w-full aspect-video bg-black"
                    title="Open before / after"
                  >
                    <img
                      src={shot.photo?.dataUrl ?? shot.capture.dataUrl}
                      alt={shot.label}
                      className="w-full h-full object-cover"
                    />
                    {shot.status === 'running' && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <RefreshCw className="w-5 h-5 animate-spin text-[#e87d0d]" />
                      </div>
                    )}
                    {anchor?.shotId === shot.id && (
                      <span className="absolute top-1 left-1 text-[9px] font-bold bg-[#e87d0d] text-white px-1 rounded">LOOK</span>
                    )}
                  </button>
                  <div className="flex items-center justify-between px-1.5 py-1">
                    <span className={`text-[10px] truncate ${shot.status === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
                      {shot.status === 'error' ? 'Failed' : shot.label}
                    </span>
                    <div className="flex items-center text-gray-500">
                      <button onClick={() => handleMove(shot, -1)} disabled={i === 0} className="p-0.5 hover:text-gray-200 disabled:opacity-30" title="Move earlier">
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <button onClick={() => handleMove(shot, 1)} disabled={i === shots.length - 1} className="p-0.5 hover:text-gray-200 disabled:opacity-30" title="Move later">
                        <ChevronRight className="w-3 h-3" />
                      </button>
                      <button onClick={() => handleRerender(shot)} disabled={!enabled || !!busy} className="p-0.5 hover:text-gray-200 disabled:opacity-30" title="Render again">
                        <RefreshCw className="w-3 h-3" />
                      </button>
                      <button onClick={() => handleRemove(shot)} disabled={shot.status === 'running'} className="p-0.5 hover:text-red-400 disabled:opacity-30" title="Remove">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {shot.error && <div className="px-1.5 pb-1.5 text-[10px] text-red-400 break-words select-text">{shot.error}</div>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 2. Photos */}
        <section className="space-y-2">
          <span className={labelClass}>2 · Photos</span>
          <label className="block space-y-1">
            <span className="text-[10px] text-gray-400">What is this place? (the biggest quality lever)</span>
            <textarea
              value={scene}
              onChange={e => {
                sceneEdited.current = true;
                setScene(e.target.value);
              }}
              rows={3}
              placeholder="e.g. a downtown street with office buildings, street trees and parked cars"
              className={`${inputClass} resize-none`}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-gray-400">Lighting, weather, time of day</span>
            <input
              value={look}
              onChange={e => setLook(e.target.value)}
              placeholder={config?.defaults.look ?? 'natural daylight, lightly overcast sky'}
              className={inputClass}
            />
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-300 flex-1 cursor-pointer">
              <input type="checkbox" checked={consistent} onChange={e => setConsistent(e.target.checked)} className="accent-[#e87d0d]" />
              <span>Same look across shots</span>
            </label>
            <select
              value={imageSize}
              onChange={e => setImageSize(e.target.value)}
              className="bg-[#13141c] border border-[#34384d] rounded px-1.5 py-1 text-[11px] text-gray-200 outline-none"
              title="Photo resolution"
            >
              {(config?.imageSizes ?? ['1K', '2K', '4K']).map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          {consistent && anchor && (
            <details className="bg-[#1e202b] border border-[#2d313e] rounded-lg p-2 text-[10px] text-gray-400">
              <summary className="cursor-pointer text-gray-300">Shared look (from the first photo)</summary>
              <p className="mt-1 leading-relaxed select-text">{anchor.look}</p>
              <button onClick={() => setAnchor(null)} className="mt-1 text-amber-300 underline">Forget this look</button>
            </details>
          )}
          <button onClick={handleRenderPending} disabled={!enabled || !!busy || pending.length === 0} className={primaryButton}>
            {busy === 'photos' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
            <span>
              {busy === 'photos'
                ? 'Rendering photos…'
                : pending.length
                ? `Render ${pending.length} photo${pending.length > 1 ? 's' : ''}`
                : 'All shots rendered'}
            </span>
          </button>
          <div className="text-[10px] text-gray-500">About 15 s per photo. Click a shot to compare before and after.</div>
        </section>

        {/* 3. Video */}
        <section className="space-y-2">
          <span className={labelClass}>3 · Video</span>
          <div className="text-[10px] text-gray-400">
            {photos.length >= 2
              ? `Flythrough: ${photos.length - 1} camera move${photos.length > 2 ? 's' : ''} through your photos, in shot order.`
              : 'One photo makes a clip; two or more make a flythrough between them.'}
          </div>
          {photos.length === 1 && (
            <input
              value={motion}
              onChange={e => setMotion(e.target.value)}
              placeholder={config?.defaults.motion ?? 'a slow forward camera move'}
              className={inputClass}
              title="Camera and scene motion for the clip"
            />
          )}
          <div className="flex items-center gap-2">
            <select
              value={resolution}
              onChange={e => setResolution(e.target.value)}
              className="bg-[#13141c] border border-[#34384d] rounded px-1.5 py-1.5 text-[11px] text-gray-200 outline-none"
              title="Video resolution"
            >
              {(config?.videoResolutions ?? ['720p', '1080p']).map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <button onClick={handleMakeVideo} disabled={!enabled || !!busy || photos.length === 0} className={primaryButton}>
              {busy === 'video' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
              <span>{busy === 'video' ? 'Generating video…' : photos.length >= 2 ? 'Make flythrough' : 'Make clip'}</span>
            </button>
          </div>
          <div className="text-[10px] text-gray-500">About 1 minute per 10-second clip.</div>

          {clips.length > 0 && (
            <div className="space-y-1.5">
              {readyClips.length > 0 && (
                <video
                  key={readyClips[Math.min(playIndex, readyClips.length - 1)]?.url}
                  src={readyClips[Math.min(playIndex, readyClips.length - 1)]?.url}
                  controls
                  autoPlay
                  onEnded={() => setPlayIndex(i => (i + 1 < readyClips.length ? i + 1 : i))}
                  className="w-full rounded-lg border border-[#2d313e] bg-black"
                />
              )}
              {clips.map((clip, i) => (
                <div key={clip.id} className="flex items-center gap-2 bg-[#1e202b] border border-[#2d313e] rounded-lg px-2 py-1.5">
                  {clip.status === 'running' && <RefreshCw className="w-3 h-3 animate-spin text-[#e87d0d] shrink-0" />}
                  {clip.status === 'error' && <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />}
                  {clip.status === 'done' && (
                    <button onClick={() => setPlayIndex(readyClips.findIndex(c => c.id === clip.id))} className="text-emerald-400 shrink-0" title="Play">
                      <Play className="w-3 h-3" />
                    </button>
                  )}
                  <span className="flex-1 text-[11px] text-gray-300 truncate" title={clip.error}>
                    {clip.label}
                    {clip.error ? ` · ${clip.error}` : ''}
                  </span>
                  {clip.url && (
                    <a href={clip.url} download={`photoreal_${i + 1}_${clip.id}.mp4`} className="text-gray-400 hover:text-gray-200" title="Download">
                      <Download className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Before / after lightbox */}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col p-6 gap-3" onClick={() => setViewing(null)}>
          <div className="flex items-center justify-between text-sm text-gray-200" onClick={e => e.stopPropagation()}>
            <span className="font-semibold">{viewing.label}</span>
            <div className="flex items-center gap-3">
              {shots.find(s => s.id === viewing.id)?.photo && (
                <a
                  href={shots.find(s => s.id === viewing.id)!.photo!.dataUrl}
                  download={`${viewing.label.replace(/\s+/g, '_').toLowerCase()}_photoreal.jpg`}
                  className="flex items-center gap-1 text-xs text-gray-300 hover:text-white"
                >
                  <Download className="w-3.5 h-3.5" /> Download photo
                </a>
              )}
              <button onClick={() => setViewing(null)} className="text-gray-400 hover:text-white" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="flex-1 grid grid-cols-2 gap-3 min-h-0" onClick={e => e.stopPropagation()}>
            <figure className="flex flex-col min-h-0">
              <img src={viewing.capture.dataUrl} alt="LiDAR view" className="flex-1 min-h-0 object-contain rounded-lg bg-[#111217]" />
              <figcaption className="text-[11px] text-gray-400 mt-1 text-center">LiDAR view</figcaption>
            </figure>
            <figure className="flex flex-col min-h-0">
              {shots.find(s => s.id === viewing.id)?.photo ? (
                <img
                  src={shots.find(s => s.id === viewing.id)!.photo!.dataUrl}
                  alt="Photoreal render"
                  className="flex-1 min-h-0 object-contain rounded-lg bg-black"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center rounded-lg bg-[#181922] text-gray-500 text-xs">Not rendered yet</div>
              )}
              <figcaption className="text-[11px] text-gray-400 mt-1 text-center">Photoreal (Nano Banana 2)</figcaption>
            </figure>
          </div>
        </div>
      )}
    </div>
  );
};
