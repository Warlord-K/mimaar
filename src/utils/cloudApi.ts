/**
 * Client for the server-side point cloud ingest API (/api/v1/clouds).
 * Large scans (.e57) are uploaded in chunks, converted on the server, and
 * loaded back as a decimated PLY the viewer can hold in memory.
 */

import { parsePlyFile, ParseResult } from './lidarParser';

export interface UploadedCloud {
  id: string;
  name: string;
  size: number;
  received: number;
  status: 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';
  progress: number;
  error?: string;
  summary?: {
    sourcePoints: number;
    outputPoints: number;
    decimationStride: number;
    origin: [number, number, number];
    hasColor: boolean;
    scans: { name: string }[];
  };
  createdAt: string;
}

const HEADERS = { 'x-requested-by': 'lidar-web-client' };

async function request<T>(method: string, route: string, body?: BodyInit | object, extra: Record<string, string> = {}): Promise<T> {
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

export type CloudProgress = { phase: 'uploading' | 'queued' | 'processing'; fraction: number };

/** Upload a file in chunks, then wait for server-side conversion to finish. */
export async function uploadCloud(file: File, onProgress: (p: CloudProgress) => void): Promise<UploadedCloud> {
  const { cloud, chunkBytes } = await request<{ cloud: UploadedCloud; chunkBytes: number }>('POST', '', {
    name: file.name,
    size: file.size
  });

  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkBytes);
    let attempt = 0;
    for (;;) {
      try {
        const r = await request<{ received: number }>('PUT', `/${cloud.id}/chunk`, chunk, {
          'Content-Type': 'application/octet-stream',
          'x-chunk-offset': String(offset)
        });
        offset = r.received;
        break;
      } catch (err) {
        if (++attempt >= 4) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    onProgress({ phase: 'uploading', fraction: offset / file.size });
  }

  await request('POST', `/${cloud.id}/complete`);
  return waitForCloud(cloud.id, onProgress);
}

export async function waitForCloud(id: string, onProgress?: (p: CloudProgress) => void): Promise<UploadedCloud> {
  for (;;) {
    const { cloud } = await request<{ cloud: UploadedCloud }>('GET', `/${id}`);
    if (cloud.status === 'ready') return cloud;
    if (cloud.status === 'failed') throw new Error(cloud.error || 'Conversion failed');
    if (cloud.status === 'queued' || cloud.status === 'processing') {
      onProgress?.({ phase: cloud.status, fraction: cloud.progress });
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Fetch a converted cloud and parse it into viewer points. */
export async function loadCloudPoints(cloud: UploadedCloud): Promise<ParseResult> {
  const res = await fetch(`/api/v1/clouds/${cloud.id}/points.ply`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Could not load ${cloud.name} (HTTP ${res.status})`);
  const parsed = parsePlyFile(await res.arrayBuffer(), cloud.name);
  parsed.metadata.format = 'E57';
  return parsed;
}
