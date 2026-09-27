"""Load LiDAR / Blender renders and turn them into a list of camera views."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageStat

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

# Aspect ratios accepted by each model.
IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
VIDEO_ASPECTS = ["16:9", "9:16"]


@dataclass
class View:
    index: int
    name: str  # e.g. "view_03"; used for every file derived from this view
    source: str  # where it came from, e.g. "lidar_grid.png[r1c0]"
    image: Image.Image


def load_views(path: Path, grid: tuple[int, int] | None = None) -> list[View]:
    """Load a single render, a contact sheet split by `grid` (rows, cols), or a folder of renders.

    Blank tiles (e.g. the empty slot in a 2x4 sheet with 7 views) are skipped.
    """
    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.suffix.lower() in IMAGE_EXTS)
        if not files:
            raise FileNotFoundError(f"No images found in {path}")
    else:
        files = [path]

    views: list[View] = []
    for f in files:
        img = to_rgb(Image.open(f))
        tiles = split_grid(img, *grid) if grid else [("", img)]
        for label, tile in tiles:
            if is_blank(tile):
                continue
            i = len(views)
            views.append(View(i, f"view_{i:02d}", f"{f.name}{label}", tile))
    return views


def to_rgb(img: Image.Image) -> Image.Image:
    """Flatten transparency onto black, which is what 'no LiDAR return' looks like."""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (0, 0, 0))
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    return img.convert("RGB")


def split_grid(img: Image.Image, rows: int, cols: int) -> list[tuple[str, Image.Image]]:
    w, h = img.size
    tw, th = w // cols, h // rows
    return [
        (f"[r{r}c{c}]", img.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th)))
        for r in range(rows)
        for c in range(cols)
    ]


def is_blank(img: Image.Image, min_std: float = 2.0) -> bool:
    return ImageStat.Stat(img.convert("L")).stddev[0] < min_std


def nearest_aspect(size: tuple[int, int], options: list[str]) -> str:
    """Pick the supported aspect ratio closest to the view's own (compared in log space)."""
    target = math.log(size[0] / size[1])

    def dist(a: str) -> float:
        w, h = (int(x) for x in a.split(":"))
        return abs(math.log(w / h) - target)

    return min(options, key=dist)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def mime_for(path: Path) -> str:
    return {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")


def comparison_sheet(pairs: list[tuple[Image.Image, Image.Image]], row_height: int = 360) -> Image.Image:
    """Stack `input | photo` rows so before/after can be judged at a glance."""

    def fit(img: Image.Image) -> Image.Image:
        return img.resize((round(img.width * row_height / img.height), row_height), Image.LANCZOS)

    rows = [(fit(a), fit(b)) for a, b in pairs]
    gap = 8
    width = max(a.width + b.width for a, b in rows) + gap
    sheet = Image.new("RGB", (width, len(rows) * (row_height + gap) - gap), (20, 20, 20))
    for i, (a, b) in enumerate(rows):
        y = i * (row_height + gap)
        sheet.paste(a, (0, y))
        sheet.paste(b, (a.width + gap, y))
    return sheet
