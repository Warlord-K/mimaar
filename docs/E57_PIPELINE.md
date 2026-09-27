# E57 point cloud ingest

Large terrestrial / mobile scans (e.g. GeoScan S1 exports) arrive as `.e57`,
often gigabytes and 100M+ points — too big to parse in the browser. They go
through the server instead:

```
.e57 ──chunked upload──▶ /api/v1/clouds ──convert (server/e57)──▶ points.ply ──▶ viewer
```

1. **Upload** in 16 MiB chunks (stays under Cloud Run's 32 MiB request cap; retried chunks are idempotent).
2. **Convert**: a pure-Node E57 reader decodes every scan, applies each scan's pose,
   drops invalid points, and evenly decimates to `CLOUD_MAX_POINTS` (default 2M).
   Georeferenced coordinates are shifted to a local origin (reported in the summary)
   so float32 keeps millimetre precision.
3. **View**: the browser loads the decimated binary PLY. Uploaded scans appear under
   **Uploaded scans** in the Scan menu and default to RGB shading when coloured.

## Uploading

From the app: **Import** (or drag & drop) a `.e57` file.

From the command line (server must be running):

```bash
LIDAR_STUDIO_API_KEY=<key> npm run upload:cloud -- path/to/scan.e57 --server http://localhost:3000
```

## API

All routes accept the usual API key (`Authorization: Bearer`, `x-api-key`).

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/clouds` | `{ name, size }` → create upload, returns `id` and `chunkBytes` |
| PUT | `/api/v1/clouds/:id/chunk` | raw bytes, header `x-chunk-offset` |
| POST | `/api/v1/clouds/:id/complete` | validate and queue conversion |
| GET | `/api/v1/clouds` | list uploads |
| GET | `/api/v1/clouds/:id` | status, progress, conversion summary |
| GET | `/api/v1/clouds/:id/points.ply` | converted cloud |
| DELETE | `/api/v1/clouds/:id` | remove upload and outputs |

## Configuration

| Env var | Default | |
|---|---|---|
| `CLOUD_DATA_DIR` | `./data/clouds` | Where uploads and conversions are stored |
| `CLOUD_MAX_POINTS` | `2000000` | Points kept for the viewer |
| `CLOUD_MAX_UPLOAD_MB` | `20480` | Largest accepted upload |

On Cloud Run the local disk is in-memory and per-instance, so point
`CLOUD_DATA_DIR` at a mounted Cloud Storage volume for anything beyond testing.

## Supported E57 features

Float (single/double), Integer and ScaledInteger fields (any bit width), constant
fields, cartesian and spherical coordinates, `cartesianInvalidState` /
`sphericalInvalidState`, per-scan pose, colour and intensity (normalised with
`colorLimits` / `intensityLimits` when present), multiple scans per file.
Embedded 2D images are ignored.
