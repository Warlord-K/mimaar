/**
 * Point cloud ingest API: chunked upload of .e57 scans, background conversion
 * to a viewer-ready PLY, and retrieval.
 *
 *   POST   /api/v1/clouds                 { name, size }  -> create upload session
 *   PUT    /api/v1/clouds/:id/chunk       raw bytes, header x-chunk-offset
 *   POST   /api/v1/clouds/:id/complete    -> queue conversion
 *   GET    /api/v1/clouds                 -> list
 *   GET    /api/v1/clouds/:id             -> status + conversion summary
 *   GET    /api/v1/clouds/:id/points.ply  -> converted cloud
 *   DELETE /api/v1/clouds/:id
 *
 * Uploads are chunked so each request stays under proxy body limits
 * (Cloud Run caps HTTP/1 requests at 32 MiB) and can be retried.
 */

import express, { RequestHandler, Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { convertE57ToPly, ConversionSummary } from './e57/convert';

export const CLOUD_CHUNK_BYTES = 16 * 1024 * 1024;
const DATA_DIR = path.resolve(process.env.CLOUD_DATA_DIR || path.join(process.cwd(), 'data', 'clouds'));
const MAX_POINTS = Number(process.env.CLOUD_MAX_POINTS || 2_000_000);
const MAX_UPLOAD_BYTES = Number(process.env.CLOUD_MAX_UPLOAD_MB || 20480) * 1024 * 1024;

type CloudStatus = 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

interface CloudRecord {
  id: string;
  name: string;
  format: 'E57';
  size: number;
  received: number;
  status: CloudStatus;
  progress: number; // 0-1 conversion progress
  error?: string;
  summary?: ConversionSummary;
  createdAt: string;
  updatedAt: string;
}

const dirFor = (id: string) => path.join(DATA_DIR, id);
const sourcePath = (id: string) => path.join(dirFor(id), 'source.e57');
const plyPath = (id: string) => path.join(dirFor(id), 'points.ply');
const metaPath = (id: string) => path.join(dirFor(id), 'meta.json');
const ID_RE = /^[a-f0-9]{16}$/;

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

// Conversions are CPU and memory heavy, so run them one at a time
let queue: Promise<void> = Promise.resolve();
function enqueueConversion(id: string) {
  queue = queue.then(() => runConversion(id)).catch(err => console.error('[clouds] queue error', err));
}

async function runConversion(id: string) {
  const rec = readRecord(id);
  if (!rec) return;
  rec.status = 'processing';
  rec.progress = 0;
  delete rec.error;
  writeRecord(rec);
  const started = Date.now();
  let lastWrite = 0;
  try {
    rec.summary = await convertE57ToPly(sourcePath(id), plyPath(id), {
      maxPoints: MAX_POINTS,
      onProgress: f => {
        rec.progress = f;
        if (Date.now() - lastWrite > 1000) {
          lastWrite = Date.now();
          writeRecord(rec);
        }
      }
    });
    rec.status = 'ready';
    rec.progress = 1;
    console.log(
      `[clouds] ${rec.name}: ${rec.summary.sourcePoints.toLocaleString()} -> ${rec.summary.outputPoints.toLocaleString()} pts in ${((Date.now() - started) / 1000).toFixed(1)}s`
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

  // Resume conversions interrupted by a restart
  for (const rec of listRecords()) {
    if (rec.status === 'queued' || rec.status === 'processing') enqueueConversion(rec.id);
  }

  const router = Router();
  const withRecord: RequestHandler = (req, res, next) => {
    const rec = readRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Cloud not found' });
    res.locals.cloud = rec;
    next();
  };

  router.post('/', auth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const size = Number(req.body?.size);
    if (!name.toLowerCase().endsWith('.e57')) {
      return res.status(400).json({ error: 'Only .e57 files are supported by this endpoint' });
    }
    if (!Number.isInteger(size) || size <= 48 || size > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: `size must be an integer between 49 and ${MAX_UPLOAD_BYTES} bytes` });
    }
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(dirFor(id), { recursive: true });
    fs.writeFileSync(sourcePath(id), '');
    const now = new Date().toISOString();
    const rec: CloudRecord = {
      id, name: path.basename(name), format: 'E57', size, received: 0,
      status: 'uploading', progress: 0, createdAt: now, updatedAt: now
    };
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
      const offset = Number(req.headers['x-chunk-offset']);
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const current = fs.statSync(sourcePath(rec.id)).size;
      if (!Number.isInteger(offset) || body.length === 0) {
        return res.status(400).json({ error: 'x-chunk-offset header and a non-empty body are required' });
      }
      // A retried chunk the server already has is acknowledged without rewriting
      if (offset + body.length <= current) return res.json({ received: current });
      if (offset !== current) return res.status(409).json({ error: 'Unexpected offset', received: current });
      if (current + body.length > rec.size) return res.status(400).json({ error: 'Chunk exceeds declared size' });
      fs.appendFileSync(sourcePath(rec.id), body);
      rec.received = current + body.length;
      writeRecord(rec);
      res.json({ received: rec.received });
    }
  );

  router.post('/:id/complete', auth, withRecord, (req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status !== 'uploading') return res.status(409).json({ error: `Cloud is ${rec.status}` });
    const received = fs.statSync(sourcePath(rec.id)).size;
    if (received !== rec.size) {
      return res.status(400).json({ error: `Upload incomplete: ${received} of ${rec.size} bytes`, received });
    }
    const sig = Buffer.alloc(8);
    const fd = fs.openSync(sourcePath(rec.id), 'r');
    fs.readSync(fd, sig, 0, 8, 0);
    fs.closeSync(fd);
    if (sig.toString('ascii') !== 'ASTM-E57') {
      rec.status = 'failed';
      rec.error = 'File is not a valid E57 (missing ASTM-E57 signature)';
      writeRecord(rec);
      return res.status(400).json({ error: rec.error });
    }
    rec.status = 'queued';
    writeRecord(rec);
    enqueueConversion(rec.id);
    res.status(202).json({ cloud: rec });
  });

  router.get('/', auth, (_req, res) => {
    res.json({ clouds: listRecords() });
  });

  router.get('/:id', auth, withRecord, (_req, res) => {
    res.json({ cloud: res.locals.cloud });
  });

  router.get('/:id/points.ply', auth, withRecord, (_req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status !== 'ready') return res.status(409).json({ error: `Cloud is ${rec.status}` });
    res.sendFile(plyPath(rec.id), { headers: { 'Content-Type': 'application/octet-stream' } });
  });

  router.delete('/:id', auth, withRecord, (_req, res) => {
    const rec: CloudRecord = res.locals.cloud;
    if (rec.status === 'processing') return res.status(409).json({ error: 'Cannot delete while processing' });
    fs.rmSync(dirFor(rec.id), { recursive: true, force: true });
    res.json({ deleted: rec.id });
  });

  return router;
}
