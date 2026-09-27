/**
 * Full-size stage over the point cloud. Photos and clips appear here the moment each request lands,
 * and the flythrough plays itself: clips are played in shot order and auto-advance as they arrive.
 */
import React, { useEffect, useRef, useState } from 'react';
import { PhotorealController } from '../hooks/usePhotoreal';
import {
  AlertCircle,
  Columns2,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Play,
  Repeat,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PhotorealStageProps {
  photoreal: PhotorealController;
}

export const PhotorealStage: React.FC<PhotorealStageProps> = ({ photoreal }) => {
  const {
    shots,
    photos,
    clips,
    busy,
    stageOpen,
    stageTab,
    playIndex,
    focusedShotId,
    setStageOpen,
    setStageTab,
    setPlayIndex,
    setFocusedShotId,
    advanceClip
  } = photoreal;

  const [compare, setCompare] = useState(false);
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const focused = shots.find(s => s.id === focusedShotId) ?? shots.find(s => s.photo) ?? shots[0];
  const clip = clips[playIndex];
  const readyCount = clips.filter(c => c.url).length;

  // Autoplay the clip the moment its blob URL appears (muted, so browsers allow it)
  useEffect(() => {
    if (clip?.url) videoRef.current?.play().catch(() => {});
  }, [clip?.url]);

  if (!stageOpen || shots.length === 0) return null;

  const tab = (value: typeof stageTab, label: string, Icon: typeof ImageIcon, count: number) => (
    <Button
      size="xs"
      variant={stageTab === value ? 'secondary' : 'ghost'}
      onClick={() => setStageTab(value)}
      className="font-normal"
    >
      <Icon className="size-3.5" />
      {label}
      {count > 0 && <span className="text-muted-foreground">{count}</span>}
    </Button>
  );

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex items-center gap-1">
          {tab('photos', 'Photos', ImageIcon, photos.length)}
          {tab('video', 'Video', Film, readyCount)}
        </div>

        {busy && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {busy === 'photos' ? 'Rendering photos' : 'Generating video'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {stageTab === 'photos' && focused?.photo && (
            <Button
              size="xs"
              variant={compare ? 'secondary' : 'ghost'}
              onClick={() => setCompare(c => !c)}
              className="font-normal"
            >
              <Columns2 className="size-3.5" />
              <span className="hidden sm:inline">Compare</span>
            </Button>
          )}
          {stageTab === 'video' && clips.length > 1 && (
            <Button size="xs" variant="ghost" onClick={() => setPlayIndex(0)} className="font-normal">
              <Repeat className="size-3.5" />
              <span className="hidden sm:inline">Replay all</span>
            </Button>
          )}
          {stageTab === 'video' && clip?.url && (
            <Button size="xs" variant="ghost" onClick={() => setMuted(m => !m)} className="font-normal">
              {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              <span className="hidden sm:inline">{muted ? 'Sound off' : 'Sound on'}</span>
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={() => setStageOpen(false)} aria-label="Back to point cloud">
            <X />
          </Button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {stageTab === 'photos' ? (
          focused ? (
            <div className={cn('grid h-full min-h-0 w-full gap-3', compare && focused.photo ? 'grid-cols-2' : 'grid-cols-1')}>
              {compare && focused.photo && (
                <figure className="flex min-h-0 flex-col gap-1.5">
                  <img src={focused.capture.dataUrl} alt="LiDAR view" className="min-h-0 flex-1 rounded-lg object-contain" />
                  <figcaption className="text-center text-xs text-muted-foreground">LiDAR view</figcaption>
                </figure>
              )}
              <figure className="relative flex min-h-0 flex-col gap-1.5">
                <img
                  src={focused.photo?.dataUrl ?? focused.capture.dataUrl}
                  alt={focused.label}
                  className={cn('min-h-0 flex-1 rounded-lg object-contain', !focused.photo && 'opacity-40')}
                />
                {focused.status === 'running' && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="flex items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 text-sm">
                      <Loader2 className="size-4 animate-spin text-primary" />
                      Rendering {focused.label}
                    </span>
                  </div>
                )}
                {focused.status === 'error' && (
                  <div className="absolute inset-x-6 top-1/2 flex -translate-y-1/2 items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="size-4 shrink-0" />
                    <span className="select-text">{focused.error}</span>
                  </div>
                )}
                <figcaption className="text-center text-xs text-muted-foreground">
                  {focused.photo ? `${focused.label} · photoreal` : focused.label}
                </figcaption>
              </figure>
            </div>
          ) : null
        ) : clips.length === 0 ? (
          <p className="text-sm text-muted-foreground">No video yet. Render photos, then make a flythrough.</p>
        ) : clip?.url ? (
          <video
            ref={videoRef}
            key={clip.url}
            src={clip.url}
            controls
            autoPlay
            muted={muted}
            playsInline
            onEnded={advanceClip}
            className="h-full max-h-full w-full rounded-lg bg-black object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            {clip?.status === 'error' ? (
              <>
                <AlertCircle className="size-6 text-destructive" />
                <span className="max-w-md text-center select-text">{clip.error}</span>
              </>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin text-primary" />
                <span>Generating {clip?.label ?? 'clip'}…</span>
                <span className="text-xs">Takes about a minute. It plays here as soon as it is ready.</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Filmstrip */}
      <div className="shrink-0 border-t p-2">
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          {stageTab === 'photos'
            ? shots.map(shot => (
                <button
                  key={shot.id}
                  onClick={() => setFocusedShotId(shot.id)}
                  title={shot.error ?? shot.label}
                  className={cn(
                    'relative h-14 w-24 shrink-0 overflow-hidden rounded-md border-2 bg-black transition-colors',
                    focused?.id === shot.id ? 'border-primary' : 'border-transparent hover:border-muted-foreground/40'
                  )}
                >
                  <img
                    src={shot.photo?.dataUrl ?? shot.capture.dataUrl}
                    alt={shot.label}
                    className={cn('size-full object-cover', !shot.photo && 'opacity-50')}
                  />
                  {shot.status === 'running' && (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                      <Loader2 className="size-4 animate-spin text-primary" />
                    </span>
                  )}
                  {shot.status === 'error' && (
                    <span className="absolute inset-0 flex items-center justify-center bg-destructive/20">
                      <AlertCircle className="size-4 text-destructive" />
                    </span>
                  )}
                </button>
              ))
            : clips.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => c.url && setPlayIndex(i)}
                  disabled={!c.url}
                  title={c.error ?? c.label}
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                    i === playIndex ? 'border-primary text-foreground' : 'text-muted-foreground',
                    c.url ? 'hover:border-muted-foreground/60' : 'cursor-default'
                  )}
                >
                  {c.status === 'running' && <Loader2 className="size-3 animate-spin text-primary" />}
                  {c.status === 'error' && <AlertCircle className="size-3 text-destructive" />}
                  {c.url && <Play className="size-3 text-primary" />}
                  <span className="max-w-[16ch] truncate">{c.label}</span>
                </button>
              ))}

          {stageTab === 'video' && clip?.url && (
            <a
              href={clip.url}
              download={`${clip.label.replace(/\W+/g, '_').toLowerCase()}.mp4`}
              className="ml-auto flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground hover:border-muted-foreground/60"
            >
              <Download className="size-3" />
              Download
            </a>
          )}
          {stageTab === 'photos' && focused?.photo && (
            <a
              href={focused.photo.dataUrl}
              download={`${focused.label.replace(/\W+/g, '_').toLowerCase()}_photoreal.jpg`}
              className="ml-auto flex h-14 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground hover:border-muted-foreground/60"
            >
              <Download className="size-3" />
              Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
