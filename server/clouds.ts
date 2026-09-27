/**
 * Point cloud ingest API.
 *
 * Accepts either a single .e57 scan or a ROS1 databag folder (*.bag plus an
 * optional calibration.yaml). Databags are mapped into a coloured E57 by the
 * Python worker (workers/bag_to_e57.py); every E57 is then built into a
 * level-of-detail octree that the browser streams with HTTP range requests.
 *
 *   POST   /api/v1/clouds                     { name, files: [{ name, size }] } -> create upload
 *   PUT    /api/v1/clouds/:id/chunk?file=N    raw bytes, header x-chunk-offset
 *   POST   /api/v1/clouds/:id/complete        -> queue processing
 *   GET    /api/v1/clouds                     -> list
 *   GET    /api/v1/clouds/:id                 -> status, progress, summary
 *   GET    /api/v1/clouds/:id/hierarchy.json  -> octree index
 *   GET    /api/v1/clouds/:id/octree.bin      -> octree nodes (supports Range)
 *   GET    /api/v1/clouds/:id/source.e57      -> the (uploaded or generated) E57
 *   DELETE /api/v1/clouds/:id
 *
 * Uploads are chunked so each request stays under proxy body limits
 * (Cloud Run caps HTTP/1 requests at 32 MiB) and can be retried.
 */

import express, { RequestHandler, Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { convertE57ToOctree, ConversionSummary } from './e57/convert';

export const CLOUD_CHUNK_BYTES = 16 * 1024 * 1024;
const DATA_DIR = path.resolve(process.env.CLOUD_DATA_DIR || path.join(process.cwd(), 'data', 'clouds'));
const MAX_UPLOAD_BYTES = Number(process.env.CLOUD_MAX_UPLOAD_MB || 51200) * 1024 * 1024;
const WORKER_SCRIPT = path.join(process.cwd(), 'workers', 'bag_to_e57.py');
const WORKER_PYTHON =
  process.env.CLOUD_PYTHON ||
  (fs.existsSync(path.join(process.cwd(), '.venv-worker', 'bin', 'python'))
    ? path.join(process.cwd(), '.venv-worker', 'bin', 'python')
    : 'python3');

type CloudStatus = 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

interface UploadFile {
  name: string;
  size: number;
  received: number;
}

interface CloudRecord {
  id: string;
  name: string;
  kind: 'e57' | 'bag';
  files: UploadFile[];
  status: CloudStatus;
  phase?: string;
  progress: number; // 0-1 overall processing progress
  error?: string;
  summary?: ConversionSummary;
  createdAt: string;
  updatedAt: string;
}

const dirFor = (id: string) => path.join(DATA_DIR, id);
const inputDir = (id: string) => path.join(dirFor(id), 'input');
const e57Path = (id: string) => path.join(dirFor(id), 'source.e57');
const metaPath = (id: string) => path.join(dirFor(id), 'meta.json');
const ID_RE = /^[a-f0-9]{16}$/;
const safeName = (n: string) => path.basename(n).replace(/[^\w.\-]/g, '_');

function readRecord(id: string): CloudRecord | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
  } catch {
    return null;
  }
}

function writeRecord(rec: CloudRecord) {
  rec.updatedAt = new Date().toISOString();
  const tmp = metaPath(rec.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, metaPath(rec.id));
}

function listRecords(): CloudRecord[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .map(readRecord)
    .filter((r): r is CloudRecord => !!r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const uploadPath = (rec: CloudRecord, i: number) =>
  rec.kind === 'e57' ? e57Path(rec.id) : path.join(inputDir(rec.id), safeName(rec.files[i].name));

// Processing is CPU and memory heavy, so run one job at a time
let queue: Promise<void> = Promise.resolve();
function enqueue(id: string) {
  queue = queue.then(() => processCloud(id)).catch(err => console.error('[clouds] queue error', err));
}

function runBagWorker(rec: CloudRecord, onProgress: (f: number, phase: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(dirFor(rec.id), 'tmp-mapping');
    const proc = spawn(WORKER_PYTHON, [WORKER_SCRIPT, '--input', inputDir(rec.id), '--output', e57Path(rec.id), '--tmp', tmp], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let pending = '';
    proc.stdout.on('data', d => {
      pending += d.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (typeof msg.progress === 'number') onProgress(msg.progress, msg.phase);
        } catch {
          /* non-JSON output from libraries */
        }
      }
    });
    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', err => reject(new Error(`Could not start bag worker (${WORKER_PYTHON}): ${err.message}. Run "npm run setup:worker".`)));
    proc.on('close', code => {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').filter(l => !/Warning/.test(l)).slice(-3).join(' ') || `Bag worker exited with ${code}`));
    });
  });
}

async function processCloud(id: string) {
  const rec = readRecord(id);
  if (!rec) return;
  rec.status = 'processing';
  rec.progress = 0;
  delete rec.error;
  writeRecord(rec);
  const started = Date.now();
  let lastWrite = 0;
  const update = (fraction: number, phase: string) => {
    rec.progress = fraction;
    rec.phase = phase;
    if (Date.now() - lastWrite > 1000) {
      lastWrite = Date.now();
      writeRecord(rec);
    }
  };
  try {
    // Databags: LiDAR mapping first (60% of the bar), then the octree
    const mapShare = rec.kind === 'bag' ? 0.6 : 0;
    if (rec.kind === 'bag') {
      await runBagWorker(rec, (f, phase) => update(f * mapShare, `Mapping: ${phase}`));
    }
    const outDir = dirFor(id);
    rec.summary = await convertE57ToOctree(e57Path(id), outDir, (f, phase) =>
      update(mapShare + f * (1 - mapShare), `Building viewer tiles: ${phase}`)
    );
    rec.status = 'ready';
    rec.progress = 1;
    rec.phase = 'Ready';
    console.log(
      `[clouds] ${rec.name}: ${rec.summary.pointCount.toLocaleString()} pts, ${rec.summary.nodeCount} nodes in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
  } catch (err: any) {
    rec.status = 'failed';
    rec.error = err?.message || String(err);
    console.error(`[clouds] ${rec.name} failed:`, err);
  }
  writeRecord(rec);
}

export function createCloudRouter(auth: RequestHandler): Router {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Resume jobs interrupted by a restart; drop uploads abandoned for over a day
  for (const rec of listRecords()) {
    if (rec.status === 'queued' || rec.status === 'processing') enqueue(rec.id);
    if (rec.status === 'uploading' && Date.now() - Date.parse(rec.updatedAt) > 24 * 3600 * 1000) {
      fs.rmSync(dirFor(rec.id), { recursive: true, force: true });
    }
  }

  const router = Router();
  const withRecord: RequestHandler = (req, res, next) => {
    const rec = readRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Cloud not found' });
    res.locals.cloud = rec;
    next();
  };

  router.post('/', auth, (req, res) => {
    // Accept { name, size } (single file) or { name, files: [{ name, size }] }
    const files: UploadFile[] = (Array.isArray(req.body?.files) ? req.body.files : [{ name: req.body?.name, size: req.body?.size }])
      .map((f: any) => ({ name: String(f?.name || '').trim(), size: Number(f?.size), received: 0 }));
    const lower = files.map(f => f.name.toLowerCase());
    const isE57 = files.length === 1 && lower[0].endsWith('.e57');
    const isBag = lower.some(n => n.endsWith('.bag')) && lower.every(n => n.endsWith('.bag') || n.endsWith('.yaml') || n.endsWith('.yml') || n.endsWith('.txt'));
    if (!isE57 && !isBag) {
      return res.status(400).json({ error: 'Upload one .e57 file, or a databag folder (.bag files plus optional calibration.yaml)' });
    }
    const total = files.reduce((s, f) => s + f.size, 0);
    if (files.some(f => !Number.isInteger(f.size) || f.size <= 0) || total > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: `File sizes must be positive integers totalling at most ${MAX_UPLOAD_BYTES} bytes` });
    }
    if (new Set(files.map(f => safeName(f.name))).size !== files.length) {
      return res.status(400).json({ error: 'File names must be unique' });
    }

    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const rec: CloudRecord = {
      id,
      name: String(req.body?.name || files[0].name).trim() || files[0].name,
      kind: isE57 ? 'e57' : 'bag',
      files,
      status: 'uploading',
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    fs.mkdirSync(isE57 ? dirFor(id) : inputDir(id), { recursive: true });
    files.forEach((_, i) => fs.writeFileSync(uploadPath(rec, i), ''));
    writeRecord(rec);
    res.status(201).json({ cloud: rec, chunkBytes: CLOUD_CHUNK_BYTES });
  });

  router.put(
    '/:id/chunk',
    auth,
    withRecord,
    express.raw({ type: () => true, limit: CLOUD_CHUNK_BYTES + 1024 }),
    (req, res) => {
      const rec: CloudRecord = res.locals.cloud;
      if (rec.status !== 'uploading') return res.status(409).json({ error: `Cloud is ${rec.status}` });
      const fileIdx = Number(req.query.file ?? 0);
      const file = rec.files[fileIdx];
      if (!Number.isInteger(fileIdx) || !file) return res.status(400).json({ error: 'Unknown file index' });
      const offset = Number(req.headers['x-chunk-offset']);
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const target = uploadPath(rec, fileIdx);
      const current = fs.statSync(target).size;
      if (!Number.isInteger(offset) || body.length === 0) {
        return res.status(400).json({ error: 'x-chunk-offset header and a non-empty body are required' });
      }
      // A retried chunk the server already has is acknowledged without rewriting
      if (offset + body.length <= current) return res.json({ received: current });
      if (offset !== current) return res.status(409).json({ error: 'Unexpected offset', received: current });
      if (current + body.length > file.size) return res.status(400).json({ error: 'Chunk exceeds declared size' });
      fs.appendFileSync(target, body);
      file.received = current + body.length;
      writeRecord(rec);
      res.json({ received: file.received });
    }
  );

  router.post('/:id/complete', auth, withRecord, (req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status !== 'uploading') return res.status(409).json({ error: `Cloud is ${rec.status}` });
    for (let i = 0; i < rec.files.length; i++) {
      const got = fs.statSync(uploadPath(rec, i)).size;
      if (got !== rec.files[i].size) {
        return res.status(400).json({ error: `Upload incomplete: ${rec.files[i].name} has ${got} of ${rec.files[i].size} bytes` });
      }
    }
    const signature = (file: string, n: number) => {
      const b = Buffer.alloc(n);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, b, 0, n, 0);
      fs.closeSync(fd);
      return b.toString('ascii');
    };
    const bad = rec.files.find((f, i) =>
      rec.kind === 'e57'
        ? signature(uploadPath(rec, i), 8) !== 'ASTM-E57'
        : f.name.toLowerCase().endsWith('.bag') && !signature(uploadPath(rec, i), 13).startsWith('#ROSBAG V2.0')
    );
    if (bad) {
      rec.status = 'failed';
      rec.error = rec.kind === 'e57' ? 'File is not a valid E57' : `${bad.name} is not a ROS1 bag`;
      writeRecord(rec);
      return res.status(400).json({ error: rec.error });
    }
    rec.status = 'queued';
    rec.phase = 'Waiting to process';
    writeRecord(rec);
    enqueue(rec.id);
    res.status(202).json({ cloud: rec });
  });

  router.get('/', auth, (_req, res) => {
    res.json({ clouds: listRecords() });
  });

  router.get('/:id', auth, withRecord, (_req, res) => {
    res.json({ cloud: res.locals.cloud });
  });

  const serveOutput = (file: string, type: string, cache = true): RequestHandler => (_req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status !== 'ready') return res.status(409).json({ error: `Cloud is ${rec.status}` });
    res.sendFile(path.join(dirFor(rec.id), file), {
      headers: { 'Content-Type': type, ...(cache ? { 'Cache-Control': 'private, max-age=86400, immutable' } : {}) },
      acceptRanges: true
    });
  };
  router.get('/:id/hierarchy.json', auth, withRecord, serveOutput('hierarchy.json', 'application/json'));
  router.get('/:id/octree.bin', auth, withRecord, serveOutput('octree.bin', 'application/octet-stream'));
  router.get('/:id/source.e57', auth, withRecord, (req, res, next) => {
    res.attachment(res.locals.cloud.name.replace(/(\.e57)?$/i, '.e57'));
    serveOutput('source.e57', 'application/octet-stream', false)(req, res, next);
  });

  router.delete('/:id', auth, withRecord, (_req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status === 'processing') return res.status(409).json({ error: 'Cannot delete while processing' });
    fs.rmSync(dirFor(rec.id), { recursive: true, force: true });
    res.json({ deleted: rec.id });
  });

  return router;
}
