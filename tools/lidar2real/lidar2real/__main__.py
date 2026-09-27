"""CLI: python -m lidar2real INPUT [options]"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from .gemini import IMAGE_MODEL, VIDEO_MODEL, Gemini
from .pipeline import Pipeline, Settings
from .prompts import DEFAULT_LOOK, DEFAULT_MOTION
from .views import load_views

log = logging.getLogger("lidar2real")


def _grid(s: str) -> tuple[int, int]:
    try:
        rows, cols = (int(x) for x in s.lower().split("x"))
        return rows, cols
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected ROWSxCOLS like 2x4, got {s!r}")


def _indices(s: str) -> list[int]:
    return [int(x) for x in s.split(",") if x.strip()]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m lidar2real",
        description="Turn LiDAR point-cloud or Blender renders into photorealistic photos (Nano Banana 2) "
                    "and videos (Gemini Omni).")
    p.add_argument("input", type=Path, help="a render, a contact sheet of renders (with --grid), or a folder of renders")
    p.add_argument("-o", "--out", type=Path, help="output folder (default: outputs/<input name>)")
    p.add_argument("--grid", type=_grid, metavar="ROWSxCOLS", help="split a contact sheet into views, e.g. 2x4")
    p.add_argument("--views", type=_indices, metavar="I,J,...",
                   help="use only these views, in this order (the flythrough follows it); default: all")

    g = p.add_argument_group("photo (Nano Banana 2)")
    g.add_argument("--source", choices=["lidar", "blender"], default="lidar", help="kind of render (default: lidar)")
    g.add_argument("--scene", default="", help='what the place is, e.g. "downtown street with parked cars and street lamps"')
    g.add_argument("--look", default=DEFAULT_LOOK, help="lighting, weather, time of day")
    g.add_argument("--image-size", choices=["512", "1K", "2K", "4K"], default="2K")
    g.add_argument("--thinking", choices=["minimal", "high"], help="Nano Banana thinking level")
    g.add_argument("--anchor", type=int, help="view whose photo sets the look for all the others (default: first view)")
    g.add_argument("--no-consistency", action="store_true", help="render every view independently")
    g.add_argument("--image-model", default=IMAGE_MODEL)

    g = p.add_argument_group("video (Gemini Omni)")
    g.add_argument("--video", choices=["none", "clips", "flythrough"], default="none",
                   help="clips: one clip per photo, joined into reel.mp4; "
                        "flythrough: camera moves between consecutive views, joined into flythrough.mp4")
    g.add_argument("--motion", default=DEFAULT_MOTION, help="camera and scene motion for --video clips")
    g.add_argument("--resolution", choices=["360p", "720p", "1080p", "4k"], default="720p")
    g.add_argument("--video-model", default=VIDEO_MODEL)

    g = p.add_argument_group("run")
    g.add_argument("--workers", type=int, default=3, help="parallel API calls (default: 3)")
    g.add_argument("--force", action="store_true", help="regenerate outputs that already exist")
    g.add_argument("--dry-run", action="store_true", help="split views and write plan.json with all prompts, no API calls")
    g.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "google_genai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    load_dotenv()
    if not args.dry_run and not (os.environ.get("GEMINI_KEY") or os.environ.get("GOOGLE_API_KEY")):
        parser.error("GEMINI_KEY is not set: copy .env.example to .env and add your key (or use --dry-run)")
    if not args.input.exists():
        parser.error(f"{args.input} does not exist")

    views = load_views(args.input, args.grid)
    if args.views:
        by_index = {v.index: v for v in views}
        unknown = [i for i in args.views if i not in by_index]
        if unknown:
            parser.error(f"unknown view(s) {unknown}; available: {sorted(by_index)}")
        views = [by_index[i] for i in args.views]
    if not views:
        parser.error("no non-blank views found in the input")
    if args.anchor is not None and args.anchor not in {v.index for v in views}:
        parser.error(f"--anchor {args.anchor} is not among the selected views")

    for v in views:
        log.info("%s  %-28s %dx%d", v.name, v.source, *v.image.size)

    settings = Settings(
        source=args.source, scene=args.scene, look=args.look,
        image_model=args.image_model, image_size=args.image_size, thinking_level=args.thinking,
        consistency=not args.no_consistency, anchor=args.anchor,
        video=args.video, video_model=args.video_model, resolution=args.resolution, motion=args.motion,
        workers=args.workers, force=args.force, dry_run=args.dry_run,
    )
    out = args.out or Path("outputs") / args.input.stem
    pipeline = Pipeline(settings, out, None if args.dry_run else Gemini())
    pipeline.run(views)

    if args.dry_run:
        log.info("dry run: view splits in %s, prompts in %s", out / "inputs", out / "plan.json")
    else:
        log.info("done: %s", out)
    if pipeline.failures:
        log.error("%d step(s) failed (re-run the same command to retry only those):\n  %s",
                  len(pipeline.failures), "\n  ".join(pipeline.failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
