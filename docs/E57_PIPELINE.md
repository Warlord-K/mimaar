# Point cloud ingest: E57 scans and ROS databags

Large mobile/terrestrial scans (e.g. GeoScan S1) are gigabytes and 100M+
points — far too big to parse in the browser. They are processed on the
server into a **streaming level-of-detail octree** and viewed like Potree:
only the detail the camera needs is loaded, points are drawn as round splats
sized to the real point spacing, and Eye-Dome Lighting shades depth.

```
databag folder ──▶ bag worker (LiDAR SLAM + camera colour) ──▶ E57 ─┐
                                                                   ├─▶ octree builder ──▶ hierarchy.json + octree.bin ──▶ browser (streams by HTTP range)
.e57 file ─────────────────────────────────────────────────────────┘
```

## Uploading

**In the app:** *Import* a `.e57` file, or click *Bags* and pick a databag
folder (the `data_N.bag` files and `calibration.yaml`). Progress shows while it
uploads and processes; the scan then opens and stays listed under
*Uploaded scans* in the Scan menu.

**From the command line** (server running):

```bash
LIDAR_STUDIO_API_KEY=<key> npm run upload:cloud -- path/to/scan.e57
LIDAR_STUDIO_API_KEY=<key> npm run upload:cloud -- path/to/DataBag_2026-09-19-08-52-18
```

Add `--server https://your-host` for a remote server.

## Setup

Databag processing needs a Python environment for the worker (E57 uploads do not):

```bash
npm run setup:worker    # creates .venv-worker with rosbags, kiss-icp, pye57, ...
```

The server uses `.venv-worker/bin/python` automatically, or `CLOUD_PYTHON` if set.

## What happens to a databag

`workers/bag_to_e57.py`:

1. Finds the bags (only `data_N.bag` when present, in numeric order), the LiDAR
   topic (Livox `CustomMsg` or `PointCloud2`) and a camera topic.
2. Runs KISS-ICP LiDAR odometry, deskewing each scan with per-point timestamps.
3. Colours points from the camera using `calibration.yaml` (equidistant fisheye
   intrinsics + LiDAR→camera extrinsics). Points outside the camera view get
   greyscale from reflectivity.
4. Thins to one point per 3 cm voxel, levels the map with IMU gravity, writes E57.

The E57 is kept and can be downloaded from the viewer (*Export*) or
`GET /api/v1/clouds/:id/source.e57`.

Limitations: odometry is LiDAR-only without loop closure, so long walks can
drift; for survey-grade results process with a LiDAR-inertial SLAM with loop
closure and upload the E57.

## Octree format

`server/pointcloud/octree.ts` builds it out of core (3 passes over the source,
~1 GB RAM for 112M points). Each point is stored once: inner nodes hold a
128³-grid sample promoted from their children; leaves hold the rest.

- `hierarchy.json`: cube, origin shift, and `[name, points, byteOffset, byteLength]` per node
- `octree.bin`: per node `uint16 xyz` (quantised to the node cube) | `uint16 intensity` | `uint8 rgb`

## API

All routes accept the usual API key (`Authorization: Bearer`, `x-api-key`).

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/clouds` | `{ name, files: [{ name, size }] }` → create upload, returns `id`, `chunkBytes` |
| PUT | `/api/v1/clouds/:id/chunk?file=N` | raw bytes for file N, header `x-chunk-offset` |
| POST | `/api/v1/clouds/:id/complete` | validate and queue processing |
| GET | `/api/v1/clouds` | list |
| GET | `/api/v1/clouds/:id` | status, phase, progress, summary |
| GET | `/api/v1/clouds/:id/hierarchy.json` | octree index |
| GET | `/api/v1/clouds/:id/octree.bin` | octree nodes (HTTP range requests) |
| GET | `/api/v1/clouds/:id/source.e57` | uploaded or generated E57 |
| DELETE | `/api/v1/clouds/:id` | remove |

Uploads are chunked (16 MiB) so each request fits Cloud Run's 32 MiB limit and can be retried.

## Configuration

| Env var | Default | |
|---|---|---|
| `CLOUD_DATA_DIR` | `./data/clouds` | Uploads and outputs |
| `CLOUD_MAX_UPLOAD_MB` | `51200` | Largest total upload |
| `CLOUD_PYTHON` | `.venv-worker/bin/python` | Python for the bag worker |

Cloud Run's local disk is in-memory and per-instance: mount a Cloud Storage
volume at `CLOUD_DATA_DIR`, and give the service enough CPU/memory (bag mapping
takes ~8 minutes and ~6 GB RAM for a 28-minute recording).
