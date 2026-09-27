/**
 * Owns all Photoreal Studio state so the controls panel (PhotorealStudio) and the viewport stage
 * (PhotorealStage) stay in sync: results appear on the stage as each request lands.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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

const PARALLEL_REQUESTS = 3;
export const MAX_SHOTS = 8;

interface UsePhotorealOptions {
  captureRef: React.MutableRefObject<ViewportCaptureFn | null>;
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  /** Scene hint for the current dataset; used until the user edits the field. */
  defaultScene: string;
}

export type StageTab = 'photos' | 'video';

export function usePhotoreal({
  captureRef,
  metadata,
  filterState,
  renderSettings,
  defaultScene
}: UsePhotorealOptions) {
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

  const [busy, setBusy] = useState<'photos' | 'video' | null>(null);

  // Viewport stage: shows results over the point cloud while they are produced
  const [stageOpen, setStageOpen] = useState(false);
  const [stageTab, setStageTab] = useState<StageTab>('photos');
  /** Index into `clips` of the clip the stage is playing; clips play in order as they arrive. */
  const [playIndex, setPlayIndex] = useState(0);
  const [focusedShotId, setFocusedShotId] = useState<string | null>(null);

  useEffect(() => {
    fetchPhotorealConfig()
      .then(setConfig)
      .catch(err => setConfigError(err.message || String(err)));
  }, []);

  useEffect(() => {
    if (!sceneEdited.current) setScene(defaultScene);
  }, [defaultScene]);

  // Release video blob URLs when the app goes away
  useEffect(() => () => clipsRef.current.forEach(c => c.url && URL.revokeObjectURL(c.url)), []);

  const photos = shots.filter(s => s.photo);
  const pending = shots.filter(s => s.status !== 'done' && s.status !== 'running');
  const enabled = !!config?.enabled;

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

  const capture = useCallback(() => {
    const taken = captureRef.current?.(1536);
    if (!taken) {
      setNotice('The viewport is not ready yet. Try again in a moment.');
      return null;
    }
    setNotice(null);
    const shot: PhotorealShot = {
      id: `shot_${Date.now()}`,
      label: `View ${shotCounter.current++}`,
      capture: taken,
      colorMode: renderSettings.colorMode,
      colormap: renderSettings.colormap,
      legend: renderSettings.colorMode === 'classification' ? visibleLegend() : [],
      status: 'idle'
    };
    setShots(prev => [...prev, shot]);
    return shot;
  }, [captureRef, renderSettings, metadata, filterState]);

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
      // Show the newest photo on the stage as soon as it lands
      setFocusedShotId(shot.id);
      if (returnLook) {
        if (res.look) setAnchor({ shotId: shot.id, look: res.look });
        else if (res.lookError)
          setNotice(`Could not describe the first photo, so shots won't share a look: ${res.lookError}`);
      }
      return res;
    } catch (err: any) {
      updateShot(shot.id, { status: 'error', error: err.message || String(err) });
      return null;
    }
  };

  /** Render every shot without a photo. The first one sets the shared look for the rest. */
  const renderPending = async () => {
    const todo = shotsRef.current.filter(s => s.status !== 'done' && s.status !== 'running');
    if (!todo.length || busy) return;
    setBusy('photos');
    setNotice(null);
    setStageTab('photos');
    setStageOpen(true);
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

  const rerenderShot = async (shot: PhotorealShot) => {
    if (busy) return;
    setBusy('photos');
    setStageTab('photos');
    setStageOpen(true);
    try {
      const isAnchor = consistent && (!anchor || anchor.shotId === shot.id);
      await renderShot(shot, isAnchor ? undefined : consistent ? anchor?.look : undefined, isAnchor);
    } finally {
      setBusy(null);
    }
  };

  const removeShot = (shot: PhotorealShot) => {
    setShots(prev => prev.filter(s => s.id !== shot.id));
    if (anchor?.shotId === shot.id) setAnchor(null);
    if (focusedShotId === shot.id) setFocusedShotId(null);
  };

  const moveShot = (shot: PhotorealShot, delta: number) =>
    setShots(prev => {
      const i = prev.findIndex(s => s.id === shot.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /** 1 photo: a clip that starts on it. 2+ photos: a camera move between each consecutive pair. */
  const makeVideo = async () => {
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
    setStageTab('video');
    setStageOpen(true);
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

  /** Step the stage player forward; stops at the last clip. */
  const advanceClip = () => setPlayIndex(i => (i + 1 < clipsRef.current.length ? i + 1 : i));

  return {
    // config
    config,
    configError,
    enabled,
    // shots & results
    shots,
    photos,
    pending,
    clips,
    anchor,
    notice,
    busy,
    // photo settings
    scene,
    look,
    imageSize,
    consistent,
    // video settings
    motion,
    resolution,
    // stage
    stageOpen,
    stageTab,
    playIndex,
    focusedShotId,
    // actions
    setScene: (value: string) => {
      sceneEdited.current = true;
      setScene(value);
    },
    setLook,
    setImageSize,
    setConsistent,
    setMotion,
    setResolution,
    setNotice,
    setAnchor,
    setStageOpen,
    setStageTab,
    setPlayIndex,
    setFocusedShotId,
    capture,
    renderPending,
    rerenderShot,
    removeShot,
    moveShot,
    makeVideo,
    advanceClip
  };
}

export type PhotorealController = ReturnType<typeof usePhotoreal>;
