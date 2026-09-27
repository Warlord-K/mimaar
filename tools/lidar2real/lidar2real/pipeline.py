"""Orchestrates render -> photo (Nano Banana 2) -> video (Gemini Omni).

Every output is written to disk as soon as it exists and is reused on the next run, so a failed or
interrupted run can simply be re-run without paying for the steps that already succeeded.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from PIL import Image

from . import prompts
from .gemini import IMAGE_MODEL, TEXT_MODEL, VIDEO_MODEL, Gemini, image_part, text_part
from .views import IMAGE_ASPECTS, VIDEO_ASPECTS, View, comparison_sheet, mime_for, nearest_aspect, png_bytes

log = logging.getLogger(__name__)

EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


@dataclass
class Settings:
    source: str = "lidar"  # "lidar" | "blender": changes how the prompt explains the input
    scene: str = ""  # optional hint about what the place is
    look: str = prompts.DEFAULT_LOOK
    image_model: str = IMAGE_MODEL
    image_size: str = "2K"
    thinking_level: str | None = None
    consistency: bool = True  # describe the anchor photo and make every other view match that look
    anchor: int | None = None  # View.index of the anchor; default is the first selected view
    video: str = "none"  # "none" | "clips" | "flythrough"
    video_model: str = VIDEO_MODEL
    resolution: str = "720p"
    motion: str = prompts.DEFAULT_MOTION
    workers: int = 3
    force: bool = False
    dry_run: bool = False


class Pipeline:
    def __init__(self, settings: Settings, out_dir: Path, gemini: Gemini | None):
        if gemini is None and not settings.dry_run:
            raise ValueError("a Gemini client is required unless dry_run is set")
        self.s = settings
        self.out = out_dir
        self.gemini = gemini
        self.failures: list[str] = []
        self._rendered: set[str] = set()  # views rendered during this run
        self._lock = threading.Lock()
        manifest = out_dir / "manifest.json"
        self.manifest = json.loads(manifest.read_text()) if manifest.exists() and not settings.dry_run else {}
        self.manifest.setdefault("views", {})
        self.manifest.setdefault("videos", {})

    def run(self, views: list[View]) -> None:
        for sub in ("inputs", "photos", "videos"):
            (self.out / sub).mkdir(parents=True, exist_ok=True)
        for v in views:
            v.image.save(self.out / "inputs" / f"{v.name}.png")

        photos = self.render_photos(views)
        if photos:
            pairs = [(v.image, Image.open(photos[v.name]).convert("RGB")) for v in views if v.name in photos]
            comparison_sheet(pairs).save(self.out / "comparison.jpg", quality=92)

        if self.s.video == "clips":
            self._concat(self.animate_clips(views, photos), self.out / "reel.mp4")
        elif self.s.video == "flythrough":
            self._concat(self.animate_flythrough(views, photos), self.out / "flythrough.mp4")

        self.manifest["settings"] = asdict(self.s)
        name = "plan.json" if self.s.dry_run else "manifest.json"
        (self.out / name).write_text(json.dumps(self.manifest, indent=2))

    # ---- photos -------------------------------------------------------------------------------

    def render_photos(self, views: list[View]) -> dict[str, Path]:
        anchor = self._anchor(views)
        # The anchor goes first; a text description of its photo then sets the look for the rest.
        photos = self._map(lambda v: self._render_view(v, None), [anchor], key=lambda v: v.name)
        rest = [v for v in views if v is not anchor]
        anchor_look = self._anchor_look(anchor, photos.get(anchor.name), rest) if self.s.consistency else None
        photos.update(self._map(lambda v: self._render_view(v, anchor_look), rest, key=lambda v: v.name))
        return photos

    def _anchor_look(self, anchor: View, photo: Path | None, rest: list[View]) -> str | None:
        """Describe the anchor photo once. Reused from the manifest while the anchor photo is unchanged."""
        if not rest or not (self.s.force or any(self._existing_photo(v) is None for v in rest)):
            return None  # nothing left to render
        if self.s.dry_run:
            return f"<description of the {anchor.name} photo, written by {TEXT_MODEL} once it exists>"
        if photo is None:
            log.warning("anchor %s has no photo; rendering the other views without a shared look", anchor.name)
            return None
        cached = self.manifest.get("anchor_look", {})
        if cached.get("view") == anchor.name and cached.get("photo") == photo.name and anchor.name not in self._rendered:
            return cached["description"]
        try:
            look = self.gemini.describe_image(photo.read_bytes(), mime_for(photo), prompts.DESCRIBE_LOOK)
        except Exception as e:
            log.warning("could not describe the anchor photo (%s); rendering the other views without a shared look", e)
            return None
        log.info("anchor look from %s: %s", anchor.name, look)
        self.manifest["anchor_look"] = {"view": anchor.name, "photo": photo.name, "description": look}
        return look

    def _render_view(self, view: View, anchor_look: str | None) -> Path | None:
        existing = self._existing_photo(view)
        if existing and not self.s.force:
            log.info("%s: keeping existing %s (use --force to redo)", view.name, existing.name)
            return existing

        aspect = nearest_aspect(view.image.size, IMAGE_ASPECTS)
        prompt = prompts.render_prompt(self.s.source, self.s.scene, self.s.look, anchor_look)
        record = {
            "source": view.source,
            "model": self.s.image_model,
            "aspect_ratio": aspect,
            "image_size": self.s.image_size,
            "matches_anchor_look": anchor_look is not None,
            "prompt": prompt,
        }
        if self.s.dry_run:
            log.info("[dry-run] %s: %s -> photo %s %s%s", view.name, view.source, aspect, self.s.image_size,
                     " (matching the anchor's look)" if anchor_look else "")
            self._record("views", view.name, record)
            return None

        inputs = [image_part(png_bytes(view.image), "image/png"), text_part(prompt)]
        log.info("%s: rendering photo with %s ...", view.name, self.s.image_model)
        media = self.gemini.generate_image(inputs, aspect, self.s.image_size, self.s.image_model, self.s.thinking_level)
        path = self.out / "photos" / f"{view.name}{EXTENSIONS.get(media.mime_type, '.jpg')}"
        path.write_bytes(media.data)
        self._rendered.add(view.name)
        record.update(photo=str(path.relative_to(self.out)), interaction_id=media.interaction_id)
        self._record("views", view.name, record)
        log.info("%s: saved %s", view.name, path)
        return path

    def _existing_photo(self, view: View) -> Path | None:
        return next(iter(sorted((self.out / "photos").glob(f"{view.name}.*"))), None)

    def _anchor(self, views: list[View]) -> View:
        if self.s.anchor is None:
            return views[0]
        for v in views:
            if v.index == self.s.anchor:
                return v
        raise ValueError(f"anchor view {self.s.anchor} is not among the selected views")

    # ---- videos -------------------------------------------------------------------------------

    def animate_clips(self, views: list[View], photos: dict[str, Path]) -> list[Path]:
        """One Omni clip per photo, starting on that photo."""
        prompt = prompts.clip_prompt(self.s.motion, self.s.scene)
        jobs = [v for v in views if v.name in photos or self.s.dry_run]
        results = self._map(
            lambda v: self._make_video(f"clip_{v.name}", [photos.get(v.name)], "image_to_video", prompt, v),
            jobs, key=lambda v: v.name)
        return [results[v.name] for v in jobs if v.name in results]

    def animate_flythrough(self, views: list[View], photos: dict[str, Path]) -> list[Path]:
        """Camera moves from each view to the next (first/last-frame interpolation), in --views order."""
        prompt = prompts.transition_prompt(self.s.scene)
        pairs = [(a, b) for a, b in zip(views, views[1:]) if self.s.dry_run or (a.name in photos and b.name in photos)]
        if len(pairs) < len(views) - 1:
            log.warning("flythrough: skipping transitions next to views whose photo is missing")
        names = [f"move_{a.name}_to_{b.name}" for a, b in pairs]
        results = self._map(
            lambda job: self._make_video(job[0], [photos.get(job[1].name), photos.get(job[2].name)], None, prompt, job[1]),
            [(n, a, b) for n, (a, b) in zip(names, pairs)], key=lambda job: job[0])
        return [results[n] for n in names if n in results]

    def _make_video(self, name: str, frames: list[Path | None], task: str | None, prompt: str, view: View) -> Path | None:
        path = self.out / "videos" / f"{name}.mp4"
        if path.exists() and not self.s.force:
            log.info("%s: keeping existing %s (use --force to redo)", name, path.name)
            return path

        aspect = nearest_aspect(view.image.size, VIDEO_ASPECTS)
        record = {
            "model": self.s.video_model,
            "frames": [f.name if f else None for f in frames],
            "task": task,
            "aspect_ratio": aspect,
            "resolution": self.s.resolution,
            "prompt": prompt,
        }
        if self.s.dry_run:
            log.info("[dry-run] %s: %d frame(s) -> video %s %s", name, len(frames), aspect, self.s.resolution)
            self._record("videos", name, record)
            return None

        inputs = [image_part(f.read_bytes(), mime_for(f)) for f in frames] + [text_part(prompt)]
        log.info("%s: generating video with %s (this can take a few minutes) ...", name, self.s.video_model)
        media = self.gemini.generate_video(inputs, task, aspect, self.s.resolution, self.s.video_model)
        path.write_bytes(media.data)
        record.update(video=str(path.relative_to(self.out)), interaction_id=media.interaction_id)
        self._record("videos", name, record)
        log.info("%s: saved %s", name, path)
        return path

    def _concat(self, clips: list[Path], dest: Path) -> None:
        if not clips:
            return
        if len(clips) == 1:
            shutil.copyfile(clips[0], dest)
            return
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            log.warning("ffmpeg not found (pip install imageio-ffmpeg); clips are in %s", self.out / "videos")
            return
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            for c in clips:
                f.write("file '{}'\n".format(str(c.resolve()).replace("'", "'\\''")))
        base = [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f.name]
        try:
            if subprocess.run([*base, "-c", "copy", str(dest)]).returncode != 0:
                log.info("stream copy failed, re-encoding %s", dest.name)
                subprocess.run([*base, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(dest)], check=True)
        finally:
            Path(f.name).unlink(missing_ok=True)
        log.info("joined %d clips -> %s", len(clips), dest)

    # ---- helpers ------------------------------------------------------------------------------

    def _map(self, fn: Callable, items: list, key: Callable) -> dict:
        """Run fn over items in parallel. Failures are logged and collected instead of aborting the run."""
        results = {}
        with ThreadPoolExecutor(max_workers=max(1, self.s.workers)) as pool:
            futures = {pool.submit(fn, item): key(item) for item in items}
            for fut in as_completed(futures):
                k = futures[fut]
                try:
                    r = fut.result()
                except Exception as e:
                    reason = f"{type(e).__name__}: {e}" if str(e) else repr(e)
                    log.error("%s failed: %s", k, reason)
                    self.failures.append(f"{k}: {reason}")
                    continue
                if r is not None:
                    results[k] = r
        return results

    def _record(self, section: str, name: str, record: dict) -> None:
        with self._lock:
            self.manifest[section][name] = record


def _find_ffmpeg() -> str | None:
    if exe := shutil.which("ffmpeg"):
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None
