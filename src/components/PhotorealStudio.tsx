/**
 * Photoreal Studio controls. All state lives in usePhotoreal; results are shown on the
 * viewport stage (PhotorealStage) as they arrive.
 */
import React from 'react';
import { MAX_SHOTS, PhotorealController } from '../hooks/usePhotoreal';
import {
  AlertCircle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Film,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface PhotorealStudioProps {
  photoreal: PhotorealController;
}

export const PhotorealStudio: React.FC<PhotorealStudioProps> = ({ photoreal }) => {
  const {
    config,
    configError,
    enabled,
    shots,
    photos,
    pending,
    clips,
    anchor,
    notice,
    busy,
    scene,
    look,
    imageSize,
    consistent,
    motion,
    resolution,
    stageOpen,
    setScene,
    setLook,
    setImageSize,
    setConsistent,
    setMotion,
    setResolution,
    setNotice,
    setAnchor,
    setStageOpen,
    setStageTab,
    setFocusedShotId,
    capture,
    renderPending,
    rerenderShot,
    removeShot,
    moveShot,
    makeVideo
  } = photoreal;

  const hasVideo = clips.some(c => c.url);

  /** With a shot: show that photo. Without: go back to whatever was last on the stage. */
  const openStage = (shotId?: string) => {
    if (shotId) {
      setFocusedShotId(shotId);
      setStageTab('photos');
    } else if (hasVideo) {
      setStageTab('video');
    }
    setStageOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {(configError || (config && !config.enabled)) && (
          <p className="flex gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>
              {configError
                ? `Photoreal service unreachable: ${configError}`
                : 'GEMINI_API_KEY is not set on the server. Add it in the AI Studio Secrets panel (or .env locally) to render.'}
            </span>
          </p>
        )}
        {notice && (
          <p className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </p>
        )}

        {/* 1. Shots */}
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">Shots</h3>
            <span className="text-xs text-muted-foreground">
              {shots.length}/{MAX_SHOTS}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Frame the cloud in the viewport, then capture each angle.</p>
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            disabled={shots.length >= MAX_SHOTS}
            onClick={() => {
              const shot = capture();
              if (shot) openStage(shot.id);
            }}
          >
            <Camera />
            Capture current view
          </Button>

          {shots.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {shots.map((shot, i) => (
                <div key={shot.id} className="overflow-hidden rounded-lg border">
                  <button
                    onClick={() => openStage(shot.id)}
                    className="relative block aspect-video w-full bg-black"
                    title="Show on stage"
                  >
                    <img
                      src={shot.photo?.dataUrl ?? shot.capture.dataUrl}
                      alt={shot.label}
                      className={cn('size-full object-cover', !shot.photo && 'opacity-60')}
                    />
                    {shot.status === 'running' && (
                      <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                        <Loader2 className="size-4 animate-spin text-primary" />
                      </span>
                    )}
                    {anchor?.shotId === shot.id && (
                      <span className="absolute top-1 left-1 rounded bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                        LOOK
                      </span>
                    )}
                  </button>
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <span className={cn('truncate text-xs', shot.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                      {shot.status === 'error' ? 'Failed' : shot.label}
                    </span>
                    <div className="flex items-center">
                      <Button size="icon-xs" variant="ghost" onClick={() => moveShot(shot, -1)} disabled={i === 0} aria-label="Move earlier">
                        <ChevronLeft />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => moveShot(shot, 1)}
                        disabled={i === shots.length - 1}
                        aria-label="Move later"
                      >
                        <ChevronRight />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => rerenderShot(shot)}
                        disabled={!enabled || !!busy}
                        aria-label="Render again"
                      >
                        <RefreshCw />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => removeShot(shot)}
                        disabled={shot.status === 'running'}
                        aria-label="Remove"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {shot.error && <p className="px-1.5 pb-1.5 text-[10px] break-words text-destructive select-text">{shot.error}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 2. Photos */}
        <section className="space-y-2.5">
          <h3 className="text-sm font-medium">Photos</h3>
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">What is this place? Biggest quality lever.</span>
            <textarea
              value={scene}
              onChange={e => setScene(e.target.value)}
              rows={3}
              placeholder="a downtown street with office buildings, street trees and parked cars"
              className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none select-text placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Lighting, weather, time of day</span>
            <Input
              value={look}
              onChange={e => setLook(e.target.value)}
              placeholder={config?.defaults.look ?? 'natural daylight, overcast'}
              className="h-9"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={consistent} onCheckedChange={setConsistent} />
              <span>Same look across shots</span>
            </label>
            <Select value={imageSize} onValueChange={setImageSize}>
              <SelectTrigger size="sm" className="w-20" aria-label="Photo resolution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="dark">
                {(config?.imageSizes ?? ['1K', '2K', '4K']).map(s => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {consistent && anchor && (
            <details className="rounded-lg border p-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Shared look (from the first photo)</summary>
              <p className="mt-1 leading-relaxed select-text">{anchor.look}</p>
              <button onClick={() => setAnchor(null)} className="mt-1 underline">
                Forget this look
              </button>
            </details>
          )}
          <Button size="lg" className="w-full" disabled={!enabled || !!busy || pending.length === 0} onClick={renderPending}>
            {busy === 'photos' ? <Loader2 className="animate-spin" /> : <ImageIcon />}
            {busy === 'photos'
              ? 'Rendering photos'
              : pending.length
                ? `Render ${pending.length} photo${pending.length > 1 ? 's' : ''}`
                : 'All shots rendered'}
          </Button>
          <p className="text-xs text-muted-foreground">About 15 seconds per photo.</p>
        </section>

        {/* 3. Video */}
        <section className="space-y-2.5">
          <h3 className="text-sm font-medium">Video</h3>
          <p className="text-xs text-muted-foreground">
            {photos.length >= 2
              ? `Flythrough: ${photos.length - 1} camera move${photos.length > 2 ? 's' : ''} through your photos, in shot order.`
              : 'One photo makes a clip; two or more make a flythrough between them.'}
          </p>
          {photos.length === 1 && (
            <Input
              value={motion}
              onChange={e => setMotion(e.target.value)}
              placeholder={config?.defaults.motion ?? 'a slow forward camera move'}
              className="h-9"
            />
          )}
          <div className="flex items-center gap-2">
            <Select value={resolution} onValueChange={setResolution}>
              <SelectTrigger size="sm" className="w-24" aria-label="Video resolution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="dark">
                {(config?.videoResolutions ?? ['720p', '1080p']).map(r => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="lg" className="flex-1" disabled={!enabled || !!busy || photos.length === 0} onClick={makeVideo}>
              {busy === 'video' ? <Loader2 className="animate-spin" /> : <Film />}
              {busy === 'video' ? 'Generating' : photos.length >= 2 ? 'Make flythrough' : 'Make clip'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">About a minute per 10-second clip. It plays on the stage as it lands.</p>
        </section>
      </div>

      {shots.length > 0 && !stageOpen && (
        <div className="shrink-0 border-t p-3">
          <Button size="lg" variant="secondary" className="w-full" onClick={() => openStage()}>
            {hasVideo ? <Film /> : <Maximize2 />}
            {hasVideo ? 'Watch flythrough' : 'Show stage'}
          </Button>
        </div>
      )}
    </div>
  );
};
