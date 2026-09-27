import {
  PhotorealConfig,
  RenderRequest,
  RenderResponse,
  VideoRequest,
  VideoResponse
} from '../types/photoreal';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-requested-by': 'lidar-web-client'
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `Server returned status ${response.status}`);
  }
  return data as T;
}

export async function fetchPhotorealConfig(): Promise<PhotorealConfig> {
  const response = await fetch('/api/v1/photoreal/config', { headers: HEADERS });
  if (!response.ok) throw new Error(`Server returned status ${response.status}`);
  return response.json();
}

export const renderPhoto = (req: RenderRequest) => post<RenderResponse>('/api/v1/photoreal/render', req);

export const generateVideo = (req: VideoRequest) => post<VideoResponse>('/api/v1/photoreal/video', req);

export function base64ToBlobUrl(base64: string, mimeType: string): string {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** Run fn over items with at most `limit` in flight; results keep input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
