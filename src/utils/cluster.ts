/**
 * Splits a point cloud into separate physical objects so the agent can act on one of them
 * ("remove one of the buildings") instead of only filtering whole ASPRS classes.
 *
 * Points are dropped into a voxel grid and neighbouring occupied voxels are flood-filled, which is
 * fast enough to run on every request and needs no external dependency.
 */
import { LidarPoint } from '../types/lidar';

export interface PointCluster {
  /** Indices into the array that was passed in. */
  indices: number[];
  count: number;
  centroid: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** Longest horizontal side, handy for describing the object. */
  footprint: number;
  height: number;
}

export interface ClusterOptions {
  /** Only cluster points with these ASPRS classes. */
  classes?: number[];
  /** Voxel edge length; defaults to ~1.5% of the cloud's largest horizontal side. */
  voxelSize?: number;
  /** Clusters smaller than this are discarded as noise. */
  minPoints?: number;
}

const NEIGHBOURS: [number, number, number][] = [];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) NEIGHBOURS.push([dx, dy, dz]);

export function clusterPoints(points: LidarPoint[], options: ClusterOptions = {}): PointCluster[] {
  const { classes, minPoints = 40 } = options;
  const wanted = classes?.length ? new Set(classes) : null;

  const selected: number[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (wanted && !wanted.has(p.classification ?? 1)) continue;
    selected.push(i);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (selected.length < minPoints) return [];

  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const voxel = options.voxelSize ?? Math.max(span * 0.015, 1e-4);

  // voxel key -> indices of the points inside it
  const grid = new Map<string, number[]>();
  const keyOf = (p: LidarPoint) =>
    `${Math.floor(p.x / voxel)},${Math.floor(p.y / voxel)},${Math.floor(p.z / voxel)}`;
  for (const i of selected) {
    const k = keyOf(points[i]);
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  }

  const seen = new Set<string>();
  const clusters: PointCluster[] = [];

  for (const start of grid.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);

    const queue = [start];
    const indices: number[] = [];
    while (queue.length) {
      const key = queue.pop()!;
      const cell = grid.get(key);
      if (!cell) continue;
      for (const i of cell) indices.push(i);

      const [cx, cy, cz] = key.split(',').map(Number);
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nk = `${cx + dx},${cy + dy},${cz + dz}`;
        if (!seen.has(nk) && grid.has(nk)) {
          seen.add(nk);
          queue.push(nk);
        }
      }
    }
    if (indices.length < minPoints) continue;

    let sx = 0, sy = 0, sz = 0;
    let lx = Infinity, ly = Infinity, lz = Infinity;
    let hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (const i of indices) {
      const p = points[i];
      sx += p.x; sy += p.y; sz += p.z;
      if (p.x < lx) lx = p.x;
      if (p.y < ly) ly = p.y;
      if (p.z < lz) lz = p.z;
      if (p.x > hx) hx = p.x;
      if (p.y > hy) hy = p.y;
      if (p.z > hz) hz = p.z;
    }
    const n = indices.length;
    clusters.push({
      indices,
      count: n,
      centroid: [sx / n, sy / n, sz / n],
      min: [lx, ly, lz],
      max: [hx, hy, hz],
      footprint: Math.max(hx - lx, hy - ly),
      height: hz - lz
    });
  }

  return clusters.sort((a, b) => b.count - a.count);
}

export type ClusterTarget = 'largest' | 'smallest' | 'tallest' | number;

/** Resolve what the agent asked for ("the largest one", "the 2nd one") to a single cluster. */
export function pickCluster(clusters: PointCluster[], target: ClusterTarget = 'largest'): PointCluster | null {
  if (!clusters.length) return null;
  if (typeof target === 'number') return clusters[Math.max(0, Math.min(clusters.length - 1, target))] ?? null;
  if (target === 'smallest') return clusters[clusters.length - 1];
  if (target === 'tallest') return clusters.reduce((a, b) => (b.height > a.height ? b : a));
  return clusters[0];
}

export function describeCluster(cluster: PointCluster, index: number): string {
  const [x, y] = cluster.centroid;
  return `#${index + 1}: ${cluster.count.toLocaleString()} pts, ${cluster.footprint.toFixed(
    1
  )}m wide, ${cluster.height.toFixed(1)}m tall, centred at (${x.toFixed(1)}, ${y.toFixed(1)})`;
}
