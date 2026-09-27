# lidar2real

Turns LiDAR point-cloud renders or Blender renders into photorealistic photos with **Nano Banana 2**
(`gemini-3.1-flash-image`), then into video with **Gemini Omni Flash** (`gemini-omni-1.1-flash`).
The pipeline runs locally; the generation itself happens through the Gemini API.

This is the batch / command-line version. The studio web app runs the same pipeline from the viewport:
open the **Photoreal** tab (server side: `server/photoreal.ts`).

## How it works

1. **Views**: the input is a single render, a contact sheet split with `--grid`, or a folder of renders
   (for example Blender frames). Blank tiles are skipped.
2. **Photos (Nano Banana 2)**: each view is sent with a prompt explaining how to read it: false colors,
   black means no LiDAR return, and scan rings are artifacts. The prompt also says to keep camera and geometry
   exactly. The first view (the *anchor*) is rendered first. A text model (`gemini-flash-latest`) then describes
   the anchor photo's look: architecture, materials, vehicles, weather and light. That description goes into every
   other view's prompt, so all views look like the same place on the same day. The anchor photo itself is not
   passed along, because Nano Banana 2 copies a reference photo's composition even when told not to.
3. **Video (Gemini Omni)**, optional:
   - `--video clips`: each photo becomes the first frame of a short clip. Clips are joined into `reel.mp4`.
   - `--video flythrough`: each pair of consecutive photos becomes the first and last frame of one continuous
     camera move. Moves are joined into `flythrough.mp4`.

## Setup

```bash
cd tools/lidar2real
python3.12 -m venv .venv            # needs Python >= 3.10 (macOS system python3 is 3.9)
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                # paste your key from https://aistudio.google.com/apikey
```

## Run

```bash
# Free preview: splits the views and writes every prompt to outputs/lidar_grid/plan.json
python -m lidar2real lidar_grid.png --grid 2x4 --dry-run

# Photos only, trying two views first
python -m lidar2real lidar_grid.png --grid 2x4 --views 0,1 \
  --scene "a street between rows of buildings with lamp posts and parked cars"

# All views + a fly-through from street level to the elevated views to top-down
python -m lidar2real lidar_grid.png --grid 2x4 --views 0,1,4,5,2,6,3 --video flythrough \
  --scene "a street between rows of buildings with lamp posts and parked cars"

# A folder of Blender renders, one clip per frame
python -m lidar2real renders/ --source blender --video clips --motion "a slow orbit to the left"
```

Here `lidar_grid.png` is a 2×4 contact sheet of 7 LiDAR views: views 0–3 are the top row and 4–6 the bottom row,
and the empty 8th slot is skipped. The order given to `--views` is the order of the flythrough, so pick a
sensible camera path.

## Outputs

```
outputs/<input name>/
  inputs/view_XX.png                 views exactly as sent to the model
  photos/view_XX.jpg                 photorealistic renders
  comparison.jpg                     input | photo, one row per view
  videos/clip_view_XX.mp4            --video clips
  videos/move_view_XX_to_view_YY.mp4 --video flythrough
  reel.mp4 / flythrough.mp4          joined video
  manifest.json                      settings, prompts and interaction IDs
```

Re-running the same command reuses everything already on disk, so after a failure it retries only the failed steps.
To redo one photo, delete that file and re-run. `--force` regenerates everything. If you redo the anchor,
use `--force`, because the other views were matched to the old anchor.

## Options

| Option | Default | What it does |
|---|---|---|
| `--grid 2x4` | – | Split a contact sheet into views |
| `--views 0,1,4` | all | Choose views and their order |
| `--scene "..."` | – | What the place is. **The biggest quality lever**: LiDAR has no color or material information |
| `--look "..."` | overcast daylight | Lighting, weather, time of day, e.g. `"golden hour, wet asphalt after rain"` |
| `--source lidar\|blender` | `lidar` | Changes how the prompt explains the input |
| `--anchor N` | first view | View whose photo sets the look for the others (its description is saved in `manifest.json`) |
| `--no-consistency` | – | Render every view independently |
| `--image-size 512\|1K\|2K\|4K` | `2K` | Photo resolution |
| `--thinking minimal\|high` | model default | `high` can help when a photo drifts from the geometry |
| `--video none\|clips\|flythrough` | `none` | See "How it works" |
| `--motion "..."` | slow forward move | Camera and scene motion for `clips` |
| `--resolution 360p\|720p\|1080p\|4k` | `720p` | Video resolution (1080p and 4k are downloaded through the Files API automatically) |
| `--image-model`, `--video-model` | Nano Banana 2, Omni Flash | e.g. `--image-model gemini-3-pro-image` for Nano Banana Pro |
| `--workers N` | `3` | Parallel API calls |
| `--dry-run` | – | No API calls; writes `plan.json` |

## Tips

- API calls per run: one image call per view. `clips` adds one video call per view, `flythrough` one per
  consecutive pair. Try `--views 0,1` first.
- To change what the model is told, edit `lidar2real/prompts.py`. Everything else is plumbing.
- Flythrough moves between very different viewpoints (for example eye level to straight down) may come out as a
  short dissolve instead of a continuous camera move. Putting an in-between view in the `--views` order helps.
- `manifest.json` stores each interaction ID. You can pass one as `previous_interaction_id` to
  `client.interactions.create` for follow-up edits such as "same shot, at night".
- All generated images and videos carry Google's invisible SynthID watermark.

## Code layout

| File | Role |
|---|---|
| `lidar2real/__main__.py` | CLI |
| `lidar2real/pipeline.py` | Orchestration, resume, parallelism, joining clips |
| `lidar2real/gemini.py` | Nano Banana 2 and Omni calls (Interactions API), retries, large-video download |
| `lidar2real/prompts.py` | Prompt templates |
| `lidar2real/views.py` | Loading and splitting inputs, aspect ratios, comparison sheet |
