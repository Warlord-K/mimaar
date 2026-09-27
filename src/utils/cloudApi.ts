/**
 * Client for the server-side point cloud ingest API (/api/v1/clouds).
 * Large scans (.e57) and ROS databag folders are uploaded in chunks and
 * processed on the server into a streaming level-of-detail octree.
 */

import { LidarMetadata } from '../types/lidar';
import { OctreeHierarchy } from './octree';

export interface UploadedCloud {
  id: string;
  name: string;
  kind: 'e57' | 'bag';
  files: { name: string; size: number; received: number }[];
  status: 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';
  phase?: string;
  progress: number;
  error?: string;
  summary?: {
    pointCount: number;
    sourcePoints: number;
    nodeCount: number;
    origin: [number, number, number];
    hasColor: boolean;
    scans: { name: string }[];
  };
  createdAt: string;
}

const HEADERS = { 'x-requested-by': 'lidar-web-client' };

async function request<T>(method: string, route: string, body?: Blob | object, extra: Record<string, string> = {}): Promise<T> {
  const isJson = body !== undefined && !(body instanceof Blob);
  const res = await fetch(`/api/v1/clouds${route}`, {
    method,
    headers: { ...HEADERS, ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : (body as Blob)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${method} ${route} failed (HTTP ${res.status})`);
  return json as T;
}

export const listClouds = () => request<{ clouds: UploadedCloud[] }>('GET', '').then(r => r.clouds);

export type CloudProgress = { phase: 'uploading' | 'queued' | 'processing'; fraction: number; detail?: string };

/**
 * Files from a databag folder the server needs: the bags and calibration.
 * GeoScan recordings are data_N.bag; when present, other bags (exports) are skipped.
 */
export function bagFolderFiles(files: File[]) {
  const recorded = files.some(f => /^data_\d+\.bag$/i.test(f.name));
  return files.filter(f =>
    (recorded ? /^data_\d+\.bag$/i.test(f.name) : /\.bag$/i.test(f.name)) || /^calibration\.ya?ml$/i.test(f.name)
  );
}

/** Upload one .e57 or a databag folder in chunks, then wait for processing. */
export async function uploadCloud(files: File[], name: string, onProgress: (p: CloudProgress) => void): Promise<UploadedCloud> {
  const { cloud, chunkBytes } = await request<{ cloud: UploadedCloud; chunkBytes: number }>('POST', '', {
    name,
    files: files.map(f => ({ name: f.name, size: f.size }))
  });

  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + chunkBytes);
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await request<{ received: number }>('PUT', `/${cloud.id}/chunk?file=${i}`, chunk, {
            'Content-Type': 'application/octet-stream',
            'x-chunk-offset': String(offset)
          });
          sent += r.received - offset;
          offset = r.received;
          break;
        } catch (err) {
          if (attempt >= 4) throw err;
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
      onProgress({ phase: 'uploading', fraction: sent / total, detail: files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : undefined });
    }
  }

  await request('POST', `/${cloud.id}/complete`);
  return waitForCloud(cloud.id, onProgress);
}

export async function waitForCloud(id: string, onProgress?: (p: CloudProgress) => void): Promise<UploadedCloud> {
  for (;;) {
    const { cloud } = await request<{ cloud: UploadedCloud }>('GET', `/${id}`);
    if (cloud.status === 'ready') return cloud;
    if (cloud.status === 'failed') throw new Error(cloud.error || 'Processing failed');
    if (cloud.status === 'queued' || cloud.status === 'processing') {
      onProgress?.({ phase: cloud.status, fraction: cloud.progress, detail: cloud.phase });
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

export const octreeUrl = (cloud: UploadedCloud) => `/api/v1/clouds/${cloud.id}/octree.bin`;
export const sourceE57Url = (cloud: UploadedCloud) => `/api/v1/clouds/${cloud.id}/source.e57`;

export async function loadHierarchy(cloud: UploadedCloud): Promise<OctreeHierarchy> {
  const res = await fetch(`/api/v1/clouds/${cloud.id}/hierarchy.json`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Could not load ${cloud.name} (HTTP ${res.status})`);
  return res.json();
}

/** Viewer metadata for a streamed cloud (bounds in the octree's local frame). */
export function octreeMetadata(cloud: UploadedCloud, h: OctreeHierarchy): LidarMetadata {
  const [minX, minY, minZ] = h.bounds.min;
  const [maxX, maxY, maxZ] = h.bounds.max;
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  return {
    filename: cloud.name,
    format: 'E57',
    pointCount: h.pointCount,
    bounds: {
      minX, maxX, minY, maxY, minZ, maxZ,
      centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, centerZ: (minZ + maxZ) / 2,
      sizeX: maxX - minX, sizeY: maxY - minY, sizeZ: maxZ - minZ
    },
    hasRGB: h.hasColor,
    hasIntensity: h.hasIntensity,
    hasClassification: false,
    intensityRange: [0, 65535],
    elevationRange: [minZ, maxZ],
    densityPerSqMeter: Number((h.pointCount / area).toFixed(1)),
    classCounts: { 1: h.pointCount }
  };
}
