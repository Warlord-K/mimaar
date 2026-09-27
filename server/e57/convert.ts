/**
 * E57 -> viewer-ready binary PLY.
 *
 * The browser viewer holds one object per point, so large scans are evenly
 * decimated down to `maxPoints`. Georeferenced clouds (coordinates in the
 * hundreds of thousands) are shifted to a local origin so float32 keeps
 * millimetre precision; the shift is reported in the summary.
 */

import fs from 'fs';
import { E57Reader, E57ScanInfo } from './reader';

export interface ConversionSummary {
  e57Version: string;
  scans: E57ScanInfo[];
  sourcePoints: number;
  outputPoints: number;
  decimationStride: number;
  origin: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  hasColor: boolean;
  hasIntensity: boolean;
}

export async function convertE57ToPly(
  srcPath: string,
  plyPath: string,
  opts: { maxPoints: number; onProgress?: (fraction: number) => void }
): Promise<ConversionSummary> {
  const reader = new E57Reader(srcPath);
  try {
    const { totalPoints, scans, version } = reader.header;
    if (totalPoints === 0) throw new Error('E57 file contains no points');
    const stride = Math.max(1, Math.ceil(totalPoints / opts.maxPoints));
    const capacity = Math.ceil(totalPoints / stride) + scans.length;
    const hasColor = scans.some(s => s.hasColor);
    const hasIntensity = scans.some(s => s.hasIntensity);

    const xyz = new Float32Array(capacity * 3);
    const inten = hasIntensity ? new Uint16Array(capacity) : null;
    const rgb = hasColor ? new Uint8Array(capacity * 3).fill(200) : null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let origin: [number, number, number] | null = null;
    let seen = 0;
    let out = 0;

    await reader.readPoints(
      batch => {
        for (let i = 0; i < batch.count; i++, seen++) {
          if (seen % stride !== 0 || out >= capacity) continue;
          if (!origin) {
            const far = Math.max(Math.abs(batch.x[i]), Math.abs(batch.y[i]), Math.abs(batch.z[i])) > 1e4;
            origin = far
              ? [Math.round(batch.x[i] / 1000) * 1000, Math.round(batch.y[i] / 1000) * 1000, Math.round(batch.z[i] / 1000) * 1000]
              : [0, 0, 0];
          }
          const p = [batch.x[i] - origin[0], batch.y[i] - origin[1], batch.z[i] - origin[2]];
          for (let a = 0; a < 3; a++) {
            xyz[out * 3 + a] = p[a];
            if (p[a] < min[a]) min[a] = p[a];
            if (p[a] > max[a]) max[a] = p[a];
          }
          if (inten && batch.intensity) inten[out] = Math.round(batch.intensity[i] * 65535);
          if (rgb && batch.r && batch.g && batch.b) {
            rgb[out * 3] = batch.r[i];
            rgb[out * 3 + 1] = batch.g[i];
            rgb[out * 3 + 2] = batch.b[i];
          }
          out++;
        }
      },
      decoded => opts.onProgress?.(decoded / totalPoints)
    );

    writePly(plyPath, out, xyz, inten, rgb, origin ?? [0, 0, 0]);
    return {
      e57Version: version,
      scans,
      sourcePoints: totalPoints,
      outputPoints: out,
      decimationStride: stride,
      origin: origin ?? [0, 0, 0],
      bounds: { min, max },
      hasColor,
      hasIntensity
    };
  } finally {
    reader.close();
  }
}

function writePly(
  path: string,
  count: number,
  xyz: Float32Array,
  inten: Uint16Array | null,
  rgb: Uint8Array | null,
  origin: [number, number, number]
) {
  const header =
    [
      'ply',
      'format binary_little_endian 1.0',
      'comment Converted from E57 by LiDAR Cloud Studio',
      `comment origin ${origin.join(' ')}`,
      `element vertex ${count}`,
      'property float x',
      'property float y',
      'property float z',
      ...(inten ? ['property ushort intensity'] : []),
      ...(rgb ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
      'end_header'
    ].join('\n') + '\n';

  const stride = 12 + (inten ? 2 : 0) + (rgb ? 3 : 0);
  const body = Buffer.allocUnsafe(count * stride);
  for (let i = 0, o = 0; i < count; i++) {
    body.writeFloatLE(xyz[i * 3], o);
    body.writeFloatLE(xyz[i * 3 + 1], o + 4);
    body.writeFloatLE(xyz[i * 3 + 2], o + 8);
    o += 12;
    if (inten) { body.writeUInt16LE(inten[i], o); o += 2; }
    if (rgb) { body[o] = rgb[i * 3]; body[o + 1] = rgb[i * 3 + 1]; body[o + 2] = rgb[i * 3 + 2]; o += 3; }
  }
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(header, 'ascii'), body]));
  fs.renameSync(tmp, path);
}
