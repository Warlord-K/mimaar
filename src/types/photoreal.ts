/**
 * Photoreal Studio: viewport capture -> photo (Nano Banana 2) -> video (Gemini Omni)
 * Mirrors the /api/v1/photoreal contract in server/photoreal.ts
 */
import { LidarColorMode } from './lidar';

export interface ViewportCapture {
  dataUrl: string; // PNG data URL of the viewport with helpers (grid, ROI box, rulers) hidden
  width: number;
  height: number;
}

/** Registered by LidarViewport; captures the current view, downscaled so the long side is <= maxSide. */
export type ViewportCaptureFn = (maxSide?: number) => ViewportCapture | null;

export interface LegendEntry {
  name: string;
  hex: string;
}

export interface PhotorealConfig {
  enabled: boolean;
  models: { image: string; video: string; describe: string };
  imageSizes: string[];
  videoResolutions: string[];
  defaults: { look: string; motion: string; imageSize: string; resolution: string };
}

export interface RenderRequest {
  image: string;
  width: number;
  height: number;
  source?: 'lidar' | 'blender';
  colorMode?: LidarColorMode;
  colormap?: string;
  legend?: LegendEntry[];
  scene?: string;
  look?: string;
  imageSize?: string;
  anchorLook?: string;
  returnLook?: boolean;
}

export interface RenderResponse {
  success: boolean;
  image: string; // base64
  mimeType: string;
  aspectRatio: string | null;
  interactionId: string | null;
  look?: string;
  lookError?: string;
  prompt: string;
  model: string;
}

export interface VideoRequest {
  frames: string[]; // 1 frame: clip starting on it; 2 frames: camera move from the first to the second
  scene?: string;
  motion?: string;
  resolution?: string;
  aspectRatio?: '16:9' | '9:16';
}

export interface VideoResponse {
  success: boolean;
  video: string; // base64 mp4
  mimeType: string;
  interactionId: string | null;
  prompt: string;
  model: string;
}

export type JobStatus = 'idle' | 'running' | 'done' | 'error';

export interface PhotorealShot {
  id: string;
  label: string;
  capture: ViewportCapture;
  colorMode: LidarColorMode;
  colormap: string;
  legend: LegendEntry[];
  status: JobStatus;
  photo?: { dataUrl: string; interactionId: string | null };
  error?: string;
}

export interface PhotorealClip {
  id: string;
  label: string;
  status: JobStatus;
  url?: string; // blob URL of the mp4
  error?: string;
}
