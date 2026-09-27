"""Convert a textured GLB scan into a colored point cloud the studio can load.

Mimaar renders point clouds, so a mesh scan is sampled across its surfaces and each point takes the
color of the texture at that spot. Output is binary PLY (x/y/z float, red/green/blue uchar,
classification uchar), which src/utils/lidarParser.ts already parses.

    python tools/glb_to_pointcloud.py scan.glb public/scans/scan.ply --points 300000

Requires: pip install trimesh pillow numpy
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

# glTF is Y-up; the studio treats Z as elevation.
GLTF_TO_Z_UP = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64)

# ASPRS classes used by the viewer's class filters: floor, walls + ceiling, and everything inside the room
GROUND, STRUCTURE, OBJECTS = 2, 6, 1


def load_meshes(path: Path) -> list[trimesh.Trimesh]:
    """Load every mesh in the file. dump() returns copies with node transforms already applied."""
    scene = trimesh.load(path, process=False, force="scene")
    meshes = [m for m in scene.dump() if isinstance(m, trimesh.Trimesh) and len(m.faces)]
    if not meshes:
        raise SystemExit(f"{path} has no triangle meshes to sample")
    return meshes


def sample_colors(mesh: trimesh.Trimesh, face_idx: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Color per sampled point, read from the mesh texture at that point's UV."""
    visual = mesh.visual
    fallback = np.full((len(points), 3), 170, dtype=np.uint8)
    try:
        uv = getattr(visual, "uv", None)
        image = getattr(getattr(visual, "material", None), "image", None)
        if uv is None or image is None:
            # Vertex colors, or a flat material color, are the next best thing.
            colors = visual.to_color().vertex_colors
            if colors is None or len(colors) != len(mesh.vertices):
                return fallback
            bary = trimesh.triangles.points_to_barycentric(mesh.triangles[face_idx], points)
            vc = colors[mesh.faces[face_idx]][:, :, :3].astype(np.float64)
            return np.einsum("ij,ijk->ik", bary, vc).clip(0, 255).astype(np.uint8)

        # Interpolate UV across each sampled triangle, then look the texel up.
        bary = trimesh.triangles.points_to_barycentric(mesh.triangles[face_idx], points)
        face_uv = np.asarray(uv)[mesh.faces[face_idx]]
        point_uv = np.einsum("ij,ijk->ik", bary, face_uv)
        return np.asarray(trimesh.visual.uv_to_color(point_uv, image))[:, :3]
    except Exception as e:  # a scan with odd materials should still convert
        print(f"  ! could not read texture colors ({e}); using flat grey", file=sys.stderr)
        return fallback


def align_to_walls(xyz: np.ndarray) -> np.ndarray:
    """Rotate about Z so the walls run along X and Y: the tightest footprint is the axis-aligned one."""
    rng = np.random.default_rng(0)
    sample = xyz[rng.choice(len(xyz), min(len(xyz), 20_000), replace=False), :2]

    def footprint(deg: float) -> float:
        a = np.radians(deg)
        rotated = sample @ np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]).T
        lo, hi = np.percentile(rotated, [1, 99], axis=0)
        return float(np.prod(hi - lo))

    best = min(np.arange(0, 90, 0.5), key=footprint)
    a = np.radians(best)
    rot = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    print(f"  squared the room to the axes (rotated {best:.1f}°)")
    return xyz @ rot.T


def plane_near_edge(values: np.ndarray, low_side: bool, bin_size: float = 0.02) -> float:
    """Walls, floor and ceiling are dense planes: take the busiest slice in the outer quarter of the range."""
    lo, hi = np.percentile(values, [0.5, 99.5])
    edges = np.arange(lo - 5 * bin_size, hi + 5 * bin_size, bin_size)
    hist, edges = np.histogram(values, edges)
    centres = (edges[:-1] + edges[1:]) / 2
    band = centres <= lo + 0.25 * (hi - lo) if low_side else centres >= hi - 0.25 * (hi - lo)
    return float(centres[np.argmax(np.where(band, hist, -1))])


def room_planes(xyz: np.ndarray) -> dict[str, float]:
    x, y, z = xyz.T
    planes = {
        "floor": plane_near_edge(z, True), "ceiling": plane_near_edge(z, False),
        "x_lo": plane_near_edge(x, True), "x_hi": plane_near_edge(x, False),
        "y_lo": plane_near_edge(y, True), "y_hi": plane_near_edge(y, False),
    }
    return planes


def inside_room(xyz: np.ndarray, planes: dict[str, float], margin: float) -> np.ndarray:
    """Mask of points within `margin` of the room shell; scan fragments floating outside get dropped."""
    x, y, z = xyz.T
    return (
        (x >= planes["x_lo"] - margin) & (x <= planes["x_hi"] + margin)
        & (y >= planes["y_lo"] - margin) & (y <= planes["y_hi"] + margin)
        & (z >= planes["floor"] - margin) & (z <= planes["ceiling"] + margin)
    )


def classify(xyz: np.ndarray, planes: dict[str, float], tolerance: float) -> np.ndarray:
    """Floor, walls + ceiling, and the objects in between, so the viewer can filter or fade the shell."""
    x, y, z = xyz.T
    floor, ceiling = planes["floor"], planes["ceiling"]
    x_lo, x_hi, y_lo, y_hi = planes["x_lo"], planes["x_hi"], planes["y_lo"], planes["y_hi"]

    cls = np.full(len(xyz), OBJECTS, dtype=np.uint8)
    shell = (
        (z >= ceiling - tolerance)
        | (x <= x_lo + tolerance) | (x >= x_hi - tolerance)
        | (y <= y_lo + tolerance) | (y >= y_hi - tolerance)
    )
    cls[shell] = STRUCTURE
    cls[z <= floor + tolerance] = GROUND
    print(f"  floor z={floor:.2f}, ceiling z={ceiling:.2f}, walls x=[{x_lo:.2f}, {x_hi:.2f}] y=[{y_lo:.2f}, {y_hi:.2f}]")
    return cls


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray, cls: np.ndarray) -> None:
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"comment generated by tools/glb_to_pointcloud.py\n"
        f"element vertex {len(xyz)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "property uchar classification\n"
        "end_header\n"
    )
    record = np.zeros(
        len(xyz),
        dtype=np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                        ("red", "u1"), ("green", "u1"), ("blue", "u1"), ("classification", "u1")]),
    )
    record["x"], record["y"], record["z"] = xyz.T
    record["red"], record["green"], record["blue"] = rgb.T
    record["classification"] = cls
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(header.encode("ascii"))
        f.write(record.tobytes())


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", type=Path, help="textured .glb / .gltf scan")
    p.add_argument("output", type=Path, help="destination .ply")
    p.add_argument("--points", type=int, default=300_000, help="points to sample (default: 300000)")
    p.add_argument("--plane-tolerance", type=float, default=0.12,
                   help="metres from the floor, walls or ceiling still counted as part of them (default: 0.12)")
    p.add_argument("--scale", type=float, default=1.0, help="multiply coordinates, e.g. if the scan is not in metres")
    args = p.parse_args()

    meshes = load_meshes(args.input)
    areas = np.array([m.area for m in meshes], dtype=np.float64)
    print(f"{args.input.name}: {len(meshes)} mesh(es), {sum(len(m.faces) for m in meshes):,} triangles")

    # Spread the sample budget over meshes by surface area so big surfaces get proportionally more points.
    budget = np.maximum(1, (areas / areas.sum() * args.points).astype(int))
    xyz_parts, rgb_parts = [], []
    for mesh, n in zip(meshes, budget):
        points, face_idx = trimesh.sample.sample_surface(mesh, int(n))
        xyz_parts.append(np.asarray(points))
        rgb_parts.append(sample_colors(mesh, face_idx, np.asarray(points)))
        print(f"  sampled {int(n):,} points from {len(mesh.faces):,} triangles")

    xyz = (np.vstack(xyz_parts) @ GLTF_TO_Z_UP.T) * args.scale
    rgb = np.vstack(rgb_parts).astype(np.uint8)
    xyz = align_to_walls(xyz)
    planes = room_planes(xyz)
    keep = inside_room(xyz, planes, margin=0.25)
    if (~keep).any():
        print(f"  dropped {int((~keep).sum()):,} stray points outside the room")
    xyz, rgb = xyz[keep], rgb[keep]
    centre = np.array([(planes["x_lo"] + planes["x_hi"]) / 2, (planes["y_lo"] + planes["y_hi"]) / 2, planes["floor"]])
    xyz -= centre  # room centred on the origin, floor at z = 0
    planes = {k: v - centre[{"floor": 2, "ceiling": 2, "x_lo": 0, "x_hi": 0, "y_lo": 1, "y_hi": 1}[k]] for k, v in planes.items()}
    cls = classify(xyz, planes, args.plane_tolerance)

    write_ply(args.output, xyz.astype(np.float32), rgb, cls)
    size = args.output.stat().st_size / 1e6
    extent = xyz.max(axis=0) - xyz.min(axis=0)
    print(f"wrote {args.output} — {len(xyz):,} points, {size:.1f} MB")
    print(f"  extent {extent[0]:.1f} x {extent[1]:.1f} x {extent[2]:.1f} (x/y/z)")
    print(f"  floor {int((cls == GROUND).sum()):,} · walls + ceiling {int((cls == STRUCTURE).sum()):,}"
          f" · objects {int((cls == OBJECTS).sum()):,}")


if __name__ == "__main__":
    main()
