/**
 * Upload an .e57 scan, or a ROS databag folder (*.bag + calibration.yaml), to a
 * running LiDAR Cloud Studio server and wait for it to be processed.
 *
 *   npm run upload:cloud -- <file.e57 | databag-folder> [--server http://localhost:3000] [--key <API_KEY>]
 *
 * The API key can also come from LIDAR_STUDIO_API_KEY; the server URL from
 * LIDAR_STUDIO_URL.
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const server = (flag('server') || process.env.LIDAR_STUDIO_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = flag('key') || process.env.LIDAR_STUDIO_API_KEY;
const file = args[0];

if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run upload:cloud -- <file.e57 | databag-folder> [--server URL] [--key API_KEY]');
  process.exit(1);
}
if (!apiKey) {
  console.error('An API key is required: pass --key or set LIDAR_STUDIO_API_KEY');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}` };

async function api(method: string, route: string, body?: any, extra: Record<string, string> = {}) {
  const res = await fetch(`${server}/api/v1/clouds${route}`, {
    method,
    headers: { ...headers, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body)
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `${method} ${route} -> HTTP ${res.status}`), { status: res.status, json });
  return json;
}

async function main() {
  const isDir = fs.statSync(file).isDirectory();
  // GeoScan recordings are data_N.bag; when present, ignore other bags (e.g. exports)
  const listing = isDir ? fs.readdirSync(file) : [];
  const recorded = listing.filter(f => /^data_\d+\.bag$/i.test(f));
  const paths = isDir
    ? listing
        .filter(f => (recorded.length ? recorded.includes(f) : /\.bag$/i.test(f)) || /^calibration\.ya?ml$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(f => path.join(file, f))
    : [file];
  if (isDir && !paths.some(p => p.endsWith('.bag'))) throw new Error(`No .bag files in ${file}`);
  const files = paths.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
  const total = files.reduce((s, f) => s + f.size, 0);
  const name = path.basename(path.resolve(file));
  const { cloud, chunkBytes } = await api('POST', '', { name, files: files.map(({ name, size }) => ({ name, size })) });
  console.log(`Uploading ${name}: ${files.length} file(s), ${(total / 1e9).toFixed(2)} GB, as ${cloud.id}`);

  const started = Date.now();
  let sent = 0;
  for (let i = 0; i < files.length; i++) {
    const fd = fs.openSync(files[i].path, 'r');
    let offset = 0;
    while (offset < files[i].size) {
      const len = Math.min(chunkBytes, files[i].size - offset);
      const chunk = Buffer.allocUnsafe(len);
      fs.readSync(fd, chunk, 0, len, offset);
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await api('PUT', `/${cloud.id}/chunk?file=${i}`, chunk, {
            'Content-Type': 'application/octet-stream',
            'x-chunk-offset': String(offset)
          });
          sent += r.received - offset;
          offset = r.received;
          break;
        } catch (err: any) {
          if (err.status === 409 && typeof err.json?.received === 'number') { sent += err.json.received - offset; offset = err.json.received; break; }
          if (attempt >= 5) throw err;
          console.warn(`  chunk at ${offset} failed (${err.message}), retrying...`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
      const mbps = sent / 1e6 / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  uploaded ${((sent / total) * 100).toFixed(1)}%  (${mbps.toFixed(0)} MB/s)   `);
    }
    fs.closeSync(fd);
  }
  process.stdout.write('\n');

  await api('POST', `/${cloud.id}/complete`);
  for (;;) {
    const { cloud: c } = await api('GET', `/${cloud.id}`);
    if (c.status === 'ready') {
      const s = c.summary;
      console.log(`\nReady: ${s.pointCount.toLocaleString()} points in ${s.nodeCount} streaming tiles, colour: ${s.hasColor ? 'yes' : 'no'}`);
      if (s.origin.some((v: number) => v !== 0)) console.log(`Coordinates shifted by origin ${s.origin.join(', ')}`);
      console.log(`Open ${server} and pick "${c.name}" from the Scan menu.`);
      return;
    }
    if (c.status === 'failed') throw new Error(`Conversion failed: ${c.error}`);
    process.stdout.write(`\r  ${(c.progress * 100).toFixed(0)}% ${c.phase ?? c.status}`.padEnd(90));
    await new Promise(r => setTimeout(r, 1500));
  }
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
