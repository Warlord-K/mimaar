/**
 * Streaming ASTM E57 point cloud reader (pure Node, no native deps).
 *
 * Reads every Data3D scan in a file, applies each scan's pose, and hands
 * decoded points to a callback in batches so files far larger than RAM can be
 * processed. Supports the encodings libE57 writes: Float (single/double),
 * Integer and ScaledInteger (bit-packed), constant integers, cartesian and
 * spherical coordinates, invalid-state flags, colour and intensity.
 */

import fs from 'fs';

// -------------------------------------------------------------
// Minimal XML parser (E57 XML is small and well-formed)
// -------------------------------------------------------------
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e] ?? m
  );

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const top = stack[stack.length - 1];
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt) + 3;
    } else if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      i = src.indexOf('>', lt) + 1;
    } else {
      // Find the closing '>' while skipping quoted attribute values
      let j = lt + 1;
      let quote = '';
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const inner = src.slice(lt + 1, j);
      i = j + 1;
      if (inner.startsWith('/')) {
        stack.pop();
        continue;
      }
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const name = body.match(/^\s*([^\s/>]+)/)![1];
      const attrs: Record<string, string> = {};
      for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[m[1]] = decodeEntities(m[2] ?? m[3]);
      }
      const node: XmlNode = { name, attrs, children: [], text: '' };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root.children[0];
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find(c => c.name === name);
const num = (n: XmlNode | undefined, fallback = 0) => {
  const v = n ? parseFloat(n.text.trim()) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

// -------------------------------------------------------------
// Paged file access: every page ends in a 4-byte CRC that is not part of the
// logical byte stream, so logical offsets must be mapped around them.
// -------------------------------------------------------------
class PagedFile {
  readonly pageSize: number;
  private readonly payload: number;

  constructor(private readonly fd: number, pageSize: number) {
    this.pageSize = pageSize;
    this.payload = pageSize - 4;
  }

  toLogical(physical: number) {
    return Math.floor(physical / this.pageSize) * this.payload + (physical % this.pageSize);
  }

  /** Read `length` logical bytes; with allowShort, stop quietly at end of file. */
  read(logical: number, length: number, allowShort = false): Buffer {
    const out = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const pos = logical + done;
      const firstPage = Math.floor(pos / this.payload);
      const inPage = pos % this.payload;
      // Read up to 1 MiB of whole pages in one syscall, then strip the CRCs
      const pages = Math.min(1024, Math.ceil((inPage + length - done) / this.payload));
      const raw = Buffer.allocUnsafe(pages * this.pageSize);
      const got = fs.readSync(this.fd, raw, 0, raw.length, firstPage * this.pageSize);
      const before = done;
      for (let p = 0; p < pages && done < length; p++) {
        const start = p * this.pageSize + (p === 0 ? inPage : 0);
        const end = Math.min(p * this.pageSize + this.payload, got);
        if (start >= end) break;
        const n = Math.min(end - start, length - done);
        raw.copy(out, done, start, start + n);
        done += n;
      }
      if (done === before) {
        if (allowShort) return out.subarray(0, done);
        throw new Error('Unexpected end of E57 file');
      }
    }
    return out;
  }
}

// Sequential reader over the logical stream with a large read-ahead buffer
class LogicalCursor {
  private buf: Buffer = Buffer.alloc(0);
  private bufStart = 0;

  constructor(private readonly file: PagedFile, public pos: number) {}

  take(length: number): Buffer {
    if (this.pos < this.bufStart || this.pos + length > this.bufStart + this.buf.length) {
      this.bufStart = this.pos;
      this.buf = this.file.read(this.pos, Math.max(length, 4 << 20), true);
      if (this.buf.length < length) throw new Error('Unexpected end of E57 file');
    }
    const off = this.pos - this.bufStart;
    this.pos += length;
    return this.buf.subarray(off, off + length);
  }
}

// -------------------------------------------------------------
// Field decoding
// -------------------------------------------------------------
interface FieldCodec {
  name: string;
  kind: 'f32' | 'f64' | 'int' | 'const';
  bits: number;
  min: number;
  scale: number;
  offset: number;
  // decoder state
  pending: Buffer;
  bitPos: number;
}

function makeCodec(node: XmlNode): FieldCodec {
  const base = { name: node.name, bits: 0, min: 0, scale: 1, offset: 0, pending: Buffer.alloc(0), bitPos: 0 };
  const type = node.attrs.type;
  if (type === 'Float') {
    return { ...base, kind: node.attrs.precision === 'single' ? 'f32' : 'f64' };
  }
  if (type === 'Integer' || type === 'ScaledInteger') {
    // min/max may exceed 2^53 for unbounded int64 fields; BigInt keeps the width exact
    const lo = BigInt(node.attrs.minimum ?? '-9223372036854775808');
    const hi = BigInt(node.attrs.maximum ?? '9223372036854775807');
    const range = hi - lo;
    const bits = range === 0n ? 0 : range.toString(2).length;
    return {
      ...base,
      kind: bits === 0 ? 'const' : 'int',
      bits,
      min: Number(lo),
      scale: type === 'ScaledInteger' ? parseFloat(node.attrs.scale ?? '1') : 1,
      offset: type === 'ScaledInteger' ? parseFloat(node.attrs.offset ?? '0') : 0
    };
  }
  throw new Error(`Unsupported E57 prototype field type '${type}' for ${node.name}`);
}

/** Decode every complete value currently buffered for this field. */
function decodeAvailable(c: FieldCodec, chunk: Buffer): Float64Array {
  const buf = c.pending.length ? Buffer.concat([c.pending, chunk]) : chunk;
  if (c.kind === 'f32' || c.kind === 'f64') {
    const size = c.kind === 'f32' ? 4 : 8;
    const n = Math.floor(buf.length / size);
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = c.kind === 'f32' ? buf.readFloatLE(k * size) : buf.readDoubleLE(k * size);
    c.pending = buf.subarray(n * size);
    return out;
  }
  // Bit-packed integers: a continuous little-endian, LSB-first bit stream
  const bits = c.bits;
  const n = Math.floor((buf.length * 8 - c.bitPos) / bits);
  const out = new Float64Array(n);
  let bit = c.bitPos;
  if (bits === 8 && bit === 0) {
    for (let k = 0; k < n; k++) out[k] = buf[k];
    bit = n * 8;
  } else if (bits <= 32) {
    const mask = 2 ** bits;
    for (let k = 0; k < n; k++, bit += bits) {
      const byte = bit >>> 3;
      const word =
        buf[byte] +
        (buf[byte + 1] ?? 0) * 0x100 +
        (buf[byte + 2] ?? 0) * 0x10000 +
        (buf[byte + 3] ?? 0) * 0x1000000 +
        (buf[byte + 4] ?? 0) * 0x100000000;
      out[k] = Math.floor(word / 2 ** (bit & 7)) % mask;
    }
  } else {
    const mask = (1n << BigInt(bits)) - 1n;
    for (let k = 0; k < n; k++, bit += bits) {
      const byte = bit >>> 3;
      let word = 0n;
      for (let b = Math.ceil(((bit & 7) + bits) / 8) - 1; b >= 0; b--) word = (word << 8n) | BigInt(buf[byte + b] ?? 0);
      out[k] = Number((word >> BigInt(bit & 7)) & mask);
    }
  }
  const consumedBytes = bit >>> 3;
  c.pending = buf.subarray(consumedBytes);
  c.bitPos = bit & 7;
  for (let k = 0; k < n; k++) out[k] = (out[k] + c.min) * c.scale + c.offset;
  return out;
}

// -------------------------------------------------------------
// Public API
// -------------------------------------------------------------
export interface E57ScanInfo {
  name: string;
  pointCount: number;
  fields: string[];
  hasColor: boolean;
  hasIntensity: boolean;
  pose: { rotation: [number, number, number, number]; translation: [number, number, number] };
}

export interface E57Header {
  version: string;
  scans: E57ScanInfo[];
  totalPoints: number;
}

export interface PointBatch {
  scanIndex: number;
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** 0-1, or null when the scan has no intensity */
  intensity: Float32Array | null;
  /** 0-255, or null when the scan has no colour */
  r: Uint8Array | null;
  g: Uint8Array | null;
  b: Uint8Array | null;
}

interface ScanPlan {
  info: E57ScanInfo;
  node: XmlNode;
  fileOffset: number;
  protoFields: XmlNode[];
  rot: number[]; // row-major 3x3
  colorLimits: [number, number][];
  intensityLimits: [number, number];
}

export class E57Reader {
  private readonly fd: number;
  private readonly file: PagedFile;
  readonly header: E57Header;
  private readonly plans: ScanPlan[];

  constructor(path: string) {
    this.fd = fs.openSync(path, 'r');
    const h = Buffer.alloc(48);
    fs.readSync(this.fd, h, 0, 48, 0);
    if (h.toString('ascii', 0, 8) !== 'ASTM-E57') {
      fs.closeSync(this.fd);
      throw new Error('Not an E57 file (missing ASTM-E57 signature)');
    }
    const major = h.readUInt32LE(8);
    const minor = h.readUInt32LE(12);
    const xmlPhysical = Number(h.readBigUInt64LE(24));
    const xmlLength = Number(h.readBigUInt64LE(32));
    const pageSize = Number(h.readBigUInt64LE(40));
    this.file = new PagedFile(this.fd, pageSize);

    const xml = this.file.read(this.file.toLogical(xmlPhysical), xmlLength).toString('utf8');
    const root = parseXml(xml);
    const data3D = child(root, 'data3D');
    this.plans = (data3D?.children ?? []).map((scan, i) => this.planScan(scan, i));
    this.header = {
      version: `${major}.${minor}`,
      scans: this.plans.map(p => p.info),
      totalPoints: this.plans.reduce((s, p) => s + p.info.pointCount, 0)
    };
  }

  private planScan(scan: XmlNode, i: number): ScanPlan {
    const points = child(scan, 'points');
    if (!points || points.attrs.type !== 'CompressedVector') throw new Error(`Scan ${i} has no point data`);
    const protoFields = child(points, 'prototype')?.children ?? [];
    const fields = protoFields.map(f => f.name);

    const pose = child(scan, 'pose');
    const q = child(pose, 'rotation');
    const t = child(pose, 'translation');
    let [w, x, y, z] = [num(child(q, 'w'), 1), num(child(q, 'x')), num(child(q, 'y')), num(child(q, 'z'))];
    const norm = Math.hypot(w, x, y, z) || 1;
    [w, x, y, z] = [w / norm, x / norm, y / norm, z / norm];
    const rot = [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    ];

    const limitsFrom = (limitsNode: string, lo: string, hi: string, field: string, dflt: [number, number]): [number, number] => {
      const l = child(scan, limitsNode);
      if (l && child(l, lo) && child(l, hi)) return [num(child(l, lo)), num(child(l, hi))];
      const f = protoFields.find(p => p.name === field);
      if (f?.attrs.minimum !== undefined && f?.attrs.maximum !== undefined && f.attrs.type === 'Integer') {
        return [parseFloat(f.attrs.minimum), parseFloat(f.attrs.maximum)];
      }
      return dflt;
    };

    return {
      node: scan,
      fileOffset: Number(points.attrs.fileOffset),
      protoFields,
      rot,
      colorLimits: (['Red', 'Green', 'Blue'] as const).map(c =>
        limitsFrom('colorLimits', `color${c}Minimum`, `color${c}Maximum`, `color${c}`, [0, 255])
      ),
      intensityLimits: limitsFrom('intensityLimits', 'intensityMinimum', 'intensityMaximum', 'intensity', [0, 1]),
      info: {
        name: child(scan, 'name')?.text.trim() || `Scan ${i}`,
        pointCount: Number(points.attrs.recordCount ?? 0),
        fields,
        hasColor: ['colorRed', 'colorGreen', 'colorBlue'].every(f => fields.includes(f)),
        hasIntensity: fields.includes('intensity'),
        pose: { rotation: [w, x, y, z], translation: [num(child(t, 'x')), num(child(t, 'y')), num(child(t, 'z'))] }
      }
    };
  }

  /**
   * Decode every point of every scan, calling onBatch with pose-applied
   * coordinates. Invalid points are dropped. Yields to the event loop
   * between batches so a server stays responsive.
   */
  async readPoints(onBatch: (batch: PointBatch) => void, onProgress?: (decoded: number) => void): Promise<void> {
    let decodedTotal = 0;
    for (let s = 0; s < this.plans.length; s++) {
      const plan = this.plans[s];
      const codecs = plan.protoFields.map(makeCodec);
      const idx = (n: string) => codecs.findIndex(c => c.name === n);
      const iX = idx('cartesianX'), iY = idx('cartesianY'), iZ = idx('cartesianZ');
      const iR = idx('sphericalRange'), iAz = idx('sphericalAzimuth'), iEl = idx('sphericalElevation');
      const iCInv = idx('cartesianInvalidState'), iSInv = idx('sphericalInvalidState');
      const iI = idx('intensity'), iRed = idx('colorRed'), iGrn = idx('colorGreen'), iBlu = idx('colorBlue');
      const cartesian = iX >= 0 && iY >= 0 && iZ >= 0;
      if (!cartesian && !(iR >= 0 && iAz >= 0 && iEl >= 0)) {
        throw new Error(`Scan '${plan.info.name}' has neither cartesian nor spherical coordinates`);
      }

      const section = this.file.read(this.file.toLogical(plan.fileOffset), 32);
      if (section[0] !== 1) throw new Error(`Scan '${plan.info.name}': bad compressed vector section`);
      const cursor = new LogicalCursor(this.file, this.file.toLogical(Number(section.readBigUInt64LE(16))));

      // Per-field queues of decoded values not yet assembled into records
      const queues: Float64Array[] = codecs.map(() => new Float64Array(0));
      let remaining = plan.info.pointCount;
      let packets = 0;
      const [iLo, iHi] = plan.intensityLimits;
      const iSpan = iHi - iLo || 1;
      const R = plan.rot;
      const [tx, ty, tz] = plan.info.pose.translation;

      while (remaining > 0) {
        const head = cursor.take(4);
        const type = head[0];
        const length = head.readUInt16LE(2) + 1;
        const body = cursor.take(length - 4);
        packets++;
        if (type !== 1) continue; // index or empty packet

        const streams = body.readUInt16LE(0);
        if (streams !== codecs.length) throw new Error(`Packet has ${streams} bytestreams, expected ${codecs.length}`);
        let off = 2 + 2 * streams;
        for (let k = 0; k < streams; k++) {
          const len = body.readUInt16LE(2 + 2 * k);
          const chunk = body.subarray(off, off + len);
          off += len;
          if (codecs[k].kind === 'const') continue;
          const vals = decodeAvailable(codecs[k], chunk);
          if (vals.length) {
            const q = queues[k];
            const merged = new Float64Array(q.length + vals.length);
            merged.set(q);
            merged.set(vals, q.length);
            queues[k] = merged;
          }
        }

        let n = remaining;
        codecs.forEach((c, k) => { if (c.kind !== 'const') n = Math.min(n, queues[k].length); });
        if (n === 0) continue;

        const col = (k: number) => (k < 0 ? null : codecs[k].kind === 'const' ? null : queues[k]);
        const constVal = (k: number) => (codecs[k].min) * codecs[k].scale + codecs[k].offset;
        const at = (k: number, i: number) => { const q = col(k); return q ? q[i] : constVal(k); };

        const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
        const inten = iI >= 0 ? new Float32Array(n) : null;
        const r = plan.info.hasColor ? new Uint8Array(n) : null;
        const g = r ? new Uint8Array(n) : null;
        const b = r ? new Uint8Array(n) : null;
        let kept = 0;
        for (let i = 0; i < n; i++) {
          if (cartesian ? iCInv >= 0 && at(iCInv, i) !== 0 : iSInv >= 0 && at(iSInv, i) !== 0) continue;
          let px: number, py: number, pz: number;
          if (cartesian) {
            px = at(iX, i); py = at(iY, i); pz = at(iZ, i);
          } else {
            const rr = at(iR, i), az = at(iAz, i), el = at(iEl, i);
            px = rr * Math.cos(el) * Math.cos(az); py = rr * Math.cos(el) * Math.sin(az); pz = rr * Math.sin(el);
          }
          x[kept] = R[0] * px + R[1] * py + R[2] * pz + tx;
          y[kept] = R[3] * px + R[4] * py + R[5] * pz + ty;
          z[kept] = R[6] * px + R[7] * py + R[8] * pz + tz;
          if (inten) inten[kept] = Math.min(1, Math.max(0, (at(iI, i) - iLo) / iSpan));
          if (r && g && b) {
            const cl = plan.colorLimits;
            r[kept] = Math.round(((at(iRed, i) - cl[0][0]) / (cl[0][1] - cl[0][0] || 1)) * 255);
            g[kept] = Math.round(((at(iGrn, i) - cl[1][0]) / (cl[1][1] - cl[1][0] || 1)) * 255);
            b[kept] = Math.round(((at(iBlu, i) - cl[2][0]) / (cl[2][1] - cl[2][0] || 1)) * 255);
          }
          kept++;
        }
        codecs.forEach((c, k) => { if (c.kind !== 'const') queues[k] = queues[k].subarray(n); });
        remaining -= n;
        decodedTotal += n;

        onBatch({
          scanIndex: s,
          count: kept,
          x: x.subarray(0, kept), y: y.subarray(0, kept), z: z.subarray(0, kept),
          intensity: inten?.subarray(0, kept) ?? null,
          r: r?.subarray(0, kept) ?? null, g: g?.subarray(0, kept) ?? null, b: b?.subarray(0, kept) ?? null
        });
        if (packets % 64 === 0) {
          onProgress?.(decodedTotal);
          await new Promise(res => setImmediate(res));
        }
      }
    }
    onProgress?.(decodedTotal);
  }

  close() {
    fs.closeSync(this.fd);
  }
}
