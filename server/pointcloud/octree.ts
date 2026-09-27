/**
 * Out-of-core level-of-detail octree builder (Potree-style) for streaming
 * very large point clouds to the browser.
 *
 * Every point is stored exactly once. Each inner node holds a grid sample
 * (one point per GRID^3 cell of its cube) promoted out of its children, so
 * drawing a node plus its loaded descendants refines the cloud additively as
 * the camera gets closer.
 *
 * Build: pass 1 finds bounds, pass 2 counts points on a 128^3 grid to split
 * the cloud into memory-sized chunks, pass 3 spills points to per-chunk temp
 * files, then each chunk's subtree is built in memory and the levels above
 * the chunks are sampled from the chunk roots.
 *
 * Output:
 *   octree.bin      concatenated nodes, each: uint16 xyz (quantised to the
 *                   node cube) | uint16 intensity | uint8 rgb, 4-byte aligned
 *   hierarchy.json  cube, origin, and [name, pointCount, byteOffset, byteLength] per node
 */

import fs from 'fs';
import path from 'path';

export const GRID = 128; // inner-node sampling resolution per axis
const LEAF_MAX = 60_000;
const CHUNK_MAX = 4_000_000;
const COUNT_LEVEL = 7; // 2^7 = 128 cells per axis for chunking
const MAX_DEPTH = 24;
const REC = 18; // temp record: f32 x,y,z (cube-relative) | u16 intensity | u8 r,g,b | pad

export interface PointBatchLike {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  intensity: Float32Array | null; // 0-1
  r: Uint8Array | null;
  g: Uint8Array | null;
  b: Uint8Array | null;
}

export interface PointSource {
  readPoints(onBatch: (b: PointBatchLike) => void, onProgress?: (decoded: number) => void): Promise<void>;
  totalPoints: number;
  hasColor: boolean;
  hasIntensity: boolean;
  close?(): void;
}

export interface OctreeSummary {
  pointCount: number;
  nodeCount: number;
  depth: number;
  origin: [number, number, number];
  cube: { min: [number, number, number]; size: number };
  bounds: { min: [number, number, number]; max: [number, number, number] };
  hasColor: boolean;
  hasIntensity: boolean;
  bytes: number;
}

// Points held in memory for one node while building
interface Pts {
  n: number;
  xyz: Float32Array; // cube-relative
  inten: Uint16Array;
  rgb: Uint8Array;
}

const emptyPts = (n: number): Pts => ({ n, xyz: new Float32Array(n * 3), inten: new Uint16Array(n), rgb: new Uint8Array(n * 3) });

function concatPts(list: Pts[]): Pts {
  const out = emptyPts(list.reduce((s, p) => s + p.n, 0));
  let o = 0;
  for (const p of list) {
    out.xyz.set(p.xyz.subarray(0, p.n * 3), o * 3);
    out.inten.set(p.inten.subarray(0, p.n), o);
    out.rgb.set(p.rgb.subarray(0, p.n * 3), o * 3);
    o += p.n;
  }
  return out;
}

const childBounds = (min: number[], size: number, c: number) => {
  const h = size / 2;
  return [min[0] + (c & 4 ? h : 0), min[1] + (c & 2 ? h : 0), min[2] + (c & 1 ? h : 0)];
};

/** Indices of the point closest to each occupied grid cell's centre. */
function gridSample(src: Pts, min: number[], size: number): Uint32Array {
  const owner = new Map<number, number>();
  const dist = new Map<number, number>();
  const s = GRID / size;
  for (let i = 0; i < src.n; i++) {
    const fx = (src.xyz[i * 3] - min[0]) * s, fy = (src.xyz[i * 3 + 1] - min[1]) * s, fz = (src.xyz[i * 3 + 2] - min[2]) * s;
    const cx = Math.min(GRID - 1, Math.max(0, fx | 0)), cy = Math.min(GRID - 1, Math.max(0, fy | 0)), cz = Math.min(GRID - 1, Math.max(0, fz | 0));
    const cell = (cx * GRID + cy) * GRID + cz;
    const d = (fx - cx - 0.5) ** 2 + (fy - cy - 0.5) ** 2 + (fz - cz - 0.5) ** 2;
    const prev = dist.get(cell);
    if (prev === undefined || d < prev) {
      owner.set(cell, i);
      dist.set(cell, d);
    }
  }
  return Uint32Array.from(owner.values()).sort();
}

function selectPts(src: Pts, keep: (i: number) => boolean): Pts {
  let n = 0;
  for (let i = 0; i < src.n; i++) if (keep(i)) n++;
  const out = emptyPts(n);
  for (let i = 0, o = 0; i < src.n; i++) {
    if (!keep(i)) continue;
    out.xyz[o * 3] = src.xyz[i * 3]; out.xyz[o * 3 + 1] = src.xyz[i * 3 + 1]; out.xyz[o * 3 + 2] = src.xyz[i * 3 + 2];
    out.inten[o] = src.inten[i];
    out.rgb[o * 3] = src.rgb[i * 3]; out.rgb[o * 3 + 1] = src.rgb[i * 3 + 1]; out.rgb[o * 3 + 2] = src.rgb[i * 3 + 2];
    o++;
  }
  return out;
}

/**
 * Promote a grid sample of the children's points into the parent, removing
 * those points from the children (each point is stored exactly once), then
 * write the children. Returns the parent's own points, still unwritten.
 */
function promote(w: NodeWriter, name: string, kids: (Pts | null)[], min: number[], size: number): Pts {
  const present = kids.map((k, c) => [k, c] as const).filter((e): e is readonly [Pts, number] => !!e[0]);
  const union = concatPts(present.map(e => e[0]));
  const taken = new Uint8Array(union.n);
  for (const i of gridSample(union, min, size)) taken[i] = 1;
  let base = 0;
  for (const [k, c] of present) {
    const off = base;
    w.write(name + c, selectPts(k, i => !taken[off + i]));
    base += k.n;
  }
  return selectPts(union, i => taken[i] === 1);
}

class NodeWriter {
  private fd: number;
  offset = 0;
  nodes: [string, number, number, number][] = [];
  depth = 0;

  constructor(file: string, private cubeSize: number) {
    this.fd = fs.openSync(file, 'w');
  }

  write(name: string, p: Pts) {
    const level = name.length - 1;
    this.depth = Math.max(this.depth, level);
    // node cube from its name
    let min = [0, 0, 0], size = this.cubeSize;
    for (let k = 1; k < name.length; k++) { min = childBounds(min, size, +name[k]); size /= 2; }
    const n = p.n;
    const bytes = Math.ceil((8 * n + 3 * n) / 4) * 4;
    const buf = Buffer.alloc(bytes);
    const q = 65535 / size;
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        const v = Math.round((p.xyz[i * 3 + a] - min[a]) * q);
        buf.writeUInt16LE(v < 0 ? 0 : v > 65535 ? 65535 : v, (i * 3 + a) * 2);
      }
      buf.writeUInt16LE(p.inten[i], 6 * n + i * 2);
      buf[8 * n + i * 3] = p.rgb[i * 3]; buf[8 * n + i * 3 + 1] = p.rgb[i * 3 + 1]; buf[8 * n + i * 3 + 2] = p.rgb[i * 3 + 2];
    }
    fs.writeSync(this.fd, buf, 0, bytes, this.offset);
    this.nodes.push([name, n, this.offset, bytes]);
    this.offset += bytes;
  }

  close() { fs.closeSync(this.fd); }
}

/** Build a subtree in memory; writes all descendants and returns this node's own (unwritten) points. */
function buildSubtree(w: NodeWriter, name: string, pts: Pts, min: number[], size: number): Pts {
  if (pts.n <= LEAF_MAX || name.length - 1 >= MAX_DEPTH) return pts;
  const h = size / 2;
  const counts = new Uint32Array(8);
  const which = new Uint8Array(pts.n);
  for (let i = 0; i < pts.n; i++) {
    const c = (pts.xyz[i * 3] >= min[0] + h ? 4 : 0) | (pts.xyz[i * 3 + 1] >= min[1] + h ? 2 : 0) | (pts.xyz[i * 3 + 2] >= min[2] + h ? 1 : 0);
    which[i] = c;
    counts[c]++;
  }
  const kids: (Pts | null)[] = [];
  for (let c = 0; c < 8; c++) {
    kids.push(counts[c] ? buildSubtree(w, name + c, selectPts(pts, i => which[i] === c), childBounds(min, size, c), h) : null);
  }
  return promote(w, name, kids, min, size);
}

export async function buildOctree(
  makeSource: () => PointSource,
  outDir: string,
  onProgress?: (fraction: number, phase: string) => void
): Promise<OctreeSummary> {
  const tmpDir = path.join(outDir, 'tmp-chunks');
  fs.mkdirSync(tmpDir, { recursive: true });
  const report = (phase: string, from: number, span: number) => (decoded: number, total: number) =>
    onProgress?.(from + span * Math.min(1, decoded / Math.max(1, total)), phase);

  // Pass 1: bounds
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let src = makeSource();
  const total = src.totalPoints;
  const { hasColor, hasIntensity } = src;
  const r1 = report('Scanning bounds', 0, 0.2);
  await src.readPoints(b => {
    for (let i = 0; i < b.count; i++) {
      if (b.x[i] < lo[0]) lo[0] = b.x[i]; if (b.x[i] > hi[0]) hi[0] = b.x[i];
      if (b.y[i] < lo[1]) lo[1] = b.y[i]; if (b.y[i] > hi[1]) hi[1] = b.y[i];
      if (b.z[i] < lo[2]) lo[2] = b.z[i]; if (b.z[i] > hi[2]) hi[2] = b.z[i];
    }
  }, d => r1(d, total));
  src.close?.();
  if (!Number.isFinite(lo[0])) throw new Error('Point cloud contains no valid points');

  // Georeferenced clouds are shifted to a local origin so float32 stays precise
  const far = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)) > 1e4;
  const origin: [number, number, number] = far ? (lo.map(v => Math.floor(v / 1000) * 1000) as any) : [0, 0, 0];
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.0001 + 1e-6;
  const cubeMin = [lo[0] - origin[0], lo[1] - origin[1], lo[2] - origin[2]];
  const G = 1 << COUNT_LEVEL;
  const cellOf = (x: number, y: number, z: number) => {
    const cx = Math.min(G - 1, ((x - lo[0]) / size * G) | 0);
    const cy = Math.min(G - 1, ((y - lo[1]) / size * G) | 0);
    const cz = Math.min(G - 1, ((z - lo[2]) / size * G) | 0);
    return (cx * G + cy) * G + cz;
  };

  // Pass 2: count per fine cell, then pick chunk roots top-down
  const counts = new Uint32Array(G * G * G);
  src = makeSource();
  const r2 = report('Counting density', 0.2, 0.15);
  await src.readPoints(b => {
    for (let i = 0; i < b.count; i++) counts[cellOf(b.x[i], b.y[i], b.z[i])]++;
  }, d => r2(d, total));
  src.close?.();

  // count of points inside octree node `name` (level <= COUNT_LEVEL), via summed cells
  const nodeCount = (level: number, ix: number, iy: number, iz: number) => {
    const span = 1 << (COUNT_LEVEL - level);
    let s = 0;
    for (let x = ix * span; x < (ix + 1) * span; x++)
      for (let y = iy * span; y < (iy + 1) * span; y++)
        for (let z = iz * span; z < (iz + 1) * span; z++) s += counts[(x * G + y) * G + z];
    return s;
  };
  const chunkOfCell = new Int32Array(G * G * G).fill(-1);
  const chunks: { name: string; level: number; ix: number; iy: number; iz: number; count: number }[] = [];
  const upper = new Set<string>(); // nodes above chunk roots
  const pick = (name: string, level: number, ix: number, iy: number, iz: number) => {
    const count = nodeCount(level, ix, iy, iz);
    if (count === 0) return;
    if (count <= CHUNK_MAX || level === COUNT_LEVEL) {
      const id = chunks.length;
      chunks.push({ name, level, ix, iy, iz, count });
      const span = 1 << (COUNT_LEVEL - level);
      for (let x = ix * span; x < (ix + 1) * span; x++)
        for (let y = iy * span; y < (iy + 1) * span; y++)
          for (let z = iz * span; z < (iz + 1) * span; z++) chunkOfCell[(x * G + y) * G + z] = id;
      return;
    }
    upper.add(name);
    for (let c = 0; c < 8; c++) pick(name + c, level + 1, ix * 2 + (c >> 2 & 1), iy * 2 + (c >> 1 & 1), iz * 2 + (c & 1));
  };
  pick('r', 0, 0, 0, 0);

  // Pass 3: spill points to per-chunk temp files
  const bufs = chunks.map(() => ({ buf: Buffer.alloc(REC * 16384), used: 0 }));
  const fds = chunks.map((_, i) => fs.openSync(path.join(tmpDir, `${i}.bin`), 'w'));
  const flush = (i: number) => { fs.writeSync(fds[i], bufs[i].buf, 0, bufs[i].used); bufs[i].used = 0; };
  src = makeSource();
  const r3 = report('Sorting points', 0.35, 0.3);
  await src.readPoints(b => {
    for (let i = 0; i < b.count; i++) {
      const id = chunkOfCell[cellOf(b.x[i], b.y[i], b.z[i])];
      const cb = bufs[id];
      const o = cb.used;
      cb.buf.writeFloatLE(b.x[i] - origin[0] - cubeMin[0], o);
      cb.buf.writeFloatLE(b.y[i] - origin[1] - cubeMin[1], o + 4);
      cb.buf.writeFloatLE(b.z[i] - origin[2] - cubeMin[2], o + 8);
      cb.buf.writeUInt16LE(b.intensity ? Math.round(b.intensity[i] * 65535) : 0, o + 12);
      cb.buf[o + 14] = b.r ? b.r[i] : 200; cb.buf[o + 15] = b.g ? b.g[i] : 200; cb.buf[o + 16] = b.b ? b.b[i] : 200;
      cb.used += REC;
      if (cb.used === cb.buf.length) flush(id);
    }
  }, d => r3(d, total));
  src.close?.();
  chunks.forEach((_, i) => { flush(i); fs.closeSync(fds[i]); });

  // Build each chunk's subtree (coordinates now cube-relative: cube spans [0, size])
  const writer = new NodeWriter(path.join(outDir, 'octree.bin.tmp'), size);
  const chunkRoots = new Map<string, Pts>();
  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const file = path.join(tmpDir, `${i}.bin`);
    const raw = fs.readFileSync(file);
    const n = raw.length / REC;
    const p = emptyPts(n);
    for (let k = 0; k < n; k++) {
      const o = k * REC;
      p.xyz[k * 3] = raw.readFloatLE(o); p.xyz[k * 3 + 1] = raw.readFloatLE(o + 4); p.xyz[k * 3 + 2] = raw.readFloatLE(o + 8);
      p.inten[k] = raw.readUInt16LE(o + 12);
      p.rgb[k * 3] = raw[o + 14]; p.rgb[k * 3 + 1] = raw[o + 15]; p.rgb[k * 3 + 2] = raw[o + 16];
    }
    fs.rmSync(file);
    const c = chunks[i];
    const csize = size / (1 << c.level);
    chunkRoots.set(c.name, buildSubtree(writer, c.name, p, [c.ix * csize, c.iy * csize, c.iz * csize], csize));
    done += n;
    onProgress?.(0.65 + 0.33 * (done / Math.max(1, total)), 'Building levels of detail');
    await new Promise(res => setImmediate(res));
  }

  // Levels above the chunks, promoted from their children; the root is written last
  const buildUpper = (name: string, min: number[], s: number): Pts | null => {
    if (chunkRoots.has(name)) return chunkRoots.get(name)!;
    if (!upper.has(name)) return null;
    const kids: (Pts | null)[] = [];
    for (let c = 0; c < 8; c++) kids.push(buildUpper(name + c, childBounds(min, s, c), s / 2));
    return promote(writer, name, kids, min, s);
  };
  writer.write('r', buildUpper('r', [0, 0, 0], size)!);
  writer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const summary: OctreeSummary = {
    pointCount: chunks.reduce((s, c) => s + c.count, 0),
    nodeCount: writer.nodes.length,
    depth: writer.depth,
    origin,
    cube: { min: cubeMin as [number, number, number], size },
    bounds: {
      min: [lo[0] - origin[0], lo[1] - origin[1], lo[2] - origin[2]],
      max: [hi[0] - origin[0], hi[1] - origin[1], hi[2] - origin[2]]
    },
    hasColor,
    hasIntensity,
    bytes: writer.offset
  };
  fs.writeFileSync(
    path.join(outDir, 'hierarchy.json'),
    JSON.stringify({ version: 1, grid: GRID, ...summary, nodes: writer.nodes })
  );
  fs.renameSync(path.join(outDir, 'octree.bin.tmp'), path.join(outDir, 'octree.bin'));
  onProgress?.(1, 'Done');
  return summary;
}
