#!/usr/bin/env python3
"""
ROS1 databag folder (e.g. GeoScan S1) -> registered, coloured E57 point cloud.

  python bag_to_e57.py --input <folder with *.bag [+ calibration.yaml]> --output out.e57 [--tmp DIR]

Pipeline:
  1. LiDAR odometry with KISS-ICP (per-point timestamps used to deskew each scan)
  2. Colourise points from the nearest camera frame using calibration.yaml
     (equidistant fisheye intrinsics + LiDAR->camera extrinsics), if present
  3. Voxel-thin to --voxel metres (one point per voxel, camera-coloured preferred)
  4. Level the map with gravity from the first second of IMU data
  5. Write E57 (cartesian, intensity, RGB)

Progress is reported on stdout as JSON lines: {"progress": 0.42, "phase": "..."}.
"""

import argparse, io, json, os, re, shutil, struct, sys, tempfile
from pathlib import Path

import numpy as np
import yaml
from PIL import Image
from rosbags.rosbag1 import Reader
from rosbags.typesys import Stores, get_types_from_msg, get_typestore
from kiss_icp.config import KISSConfig
from kiss_icp.kiss_icp import KissICP
import pye57


def report(progress, phase):
    print(json.dumps({"progress": round(float(progress), 4), "phase": phase}), flush=True)


def find_bags(folder):
    bags = list(Path(folder).rglob("*.bag"))
    if not bags:
        raise SystemExit("No .bag files found in upload")
    # GeoScan recordings are data_N.bag; when present, ignore any other bags (exports)
    recorded = [b for b in bags if re.fullmatch(r"data_\d+\.bag", b.name)]
    if recorded:
        bags = recorded
    numbered = [b for b in bags if re.search(r"_(\d+)\.bag$", b.name)]
    if len(numbered) == len(bags):
        return sorted(bags, key=lambda b: int(re.search(r"_(\d+)\.bag$", b.name).group(1)))
    starts = {}
    for b in bags:
        with Reader(b) as r:
            starts[b] = r.start_time
    return sorted(bags, key=starts.get)


def make_typestore(bags):
    ts = get_typestore(Stores.ROS1_NOETIC)
    extra = {}
    with Reader(bags[0]) as r:
        for c in r.connections:
            if c.msgtype in ts.types or not c.msgdef:
                continue
            parts = re.split(r"\n=+\nMSG: ", c.msgdef)
            extra.update(get_types_from_msg(parts[0], c.msgtype))
            for p in parts[1:]:
                name, body = p.split("\n", 1)
                name = name.strip()
                full = name if "/msg/" in name else name.replace("/", "/msg/")
                if full not in ts.types:
                    extra.update(get_types_from_msg(body, full))
    ts.register(extra)
    return ts


# --- message decoding (raw bytes, fast paths) -------------------------------------------

LIVOX_PT = np.dtype([("offset_time", "<u4"), ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                     ("reflectivity", "u1"), ("tag", "u1"), ("line", "u1")])
PF_TYPES = {1: "i1", 2: "u1", 3: "<i2", 4: "<u2", 5: "<i4", 6: "<u4", 7: "<f4", 8: "<f8"}


def header_stamp(raw):
    _, sec, nsec, flen = struct.unpack_from("<IIII", raw, 0)
    return sec * 10**9 + nsec, 16 + flen


def decode_livox(raw):
    st, o = header_stamp(raw)
    o += 8 + 4 + 1 + 3  # timebase, point_num, lidar_id, rsvd
    n, = struct.unpack_from("<I", raw, o)
    p = np.frombuffer(raw, LIVOX_PT, count=n, offset=o + 4)
    p = p[(p["x"] != 0) | (p["y"] != 0) | (p["z"] != 0)]
    xyz = np.stack([p["x"], p["y"], p["z"]], 1).astype(np.float64)
    t = p["offset_time"].astype(np.float64)
    return st, xyz, p["reflectivity"].astype(np.float32), t


def decode_pc2(ts, raw, msgtype):
    m = ts.deserialize_ros1(raw, msgtype)
    st = m.header.stamp.sec * 10**9 + m.header.stamp.nanosec
    fields = {f.name: (f.offset, PF_TYPES[f.datatype]) for f in m.fields}
    dt = np.dtype({"names": list(fields), "formats": [v[1] for v in fields.values()],
                   "offsets": [v[0] for v in fields.values()], "itemsize": m.point_step})
    p = np.frombuffer(m.data.tobytes(), dt, count=m.width * m.height)
    xyz = np.stack([p["x"], p["y"], p["z"]], 1).astype(np.float64)
    ok = np.isfinite(xyz).all(1) & (np.abs(xyz).sum(1) > 0)
    inten = next((p[k] for k in ("intensity", "reflectivity") if k in fields), np.zeros(len(p)))
    t = next((p[k].astype(np.float64) for k in ("offset_time", "timestamp", "t", "time") if k in fields), None)
    return st, xyz[ok], np.asarray(inten, np.float32)[ok], (t[ok] if t is not None else None)


def decode_jpeg(raw):
    st, o = header_stamp(raw)
    fl, = struct.unpack_from("<I", raw, o)
    o += 4 + fl
    n, = struct.unpack_from("<I", raw, o)
    return st, raw[o + 4:o + 4 + n]


# --- camera projection ---------------------------------------------------------------------

class Camera:
    def __init__(self, cal):
        ci = cal["camera_info"]
        self.K = [ci["cam_fx"], ci["cam_fy"], ci["cam_cx"], ci["cam_cy"]]
        self.D = [ci.get(k, 0.0) for k in ("k1", "k2", "k3", "k4")]
        self.W, self.H = ci["cam_width"], ci["cam_height"]
        ex = cal["extrin_lidar_camera"]
        self.R = np.array(ex["R"], float).reshape(3, 3)
        self.P = np.array(ex["P"], float)

    def project(self, p):
        c = p @ self.R.T + self.P
        rxy = np.hypot(c[:, 0], c[:, 1])
        th = np.arctan2(rxy, c[:, 2])
        th2 = th * th
        thd = th * (1 + self.D[0] * th2 + self.D[1] * th2**2 + self.D[2] * th2**3 + self.D[3] * th2**4)
        s = np.where(rxy > 1e-9, thd / np.maximum(rxy, 1e-9), 0)
        u = self.K[0] * c[:, 0] * s + self.K[2]
        v = self.K[1] * c[:, 1] * s + self.K[3]
        ok = (th < np.radians(80)) & (u >= 2) & (u < self.W - 2) & (v >= 2) & (v < self.H - 2)
        return u, v, ok


def gravity_rotation(bags, ts):
    acc = []
    for b in bags[:1]:
        with Reader(b) as r:
            ic = [c for c in r.connections if c.msgtype == "sensor_msgs/msg/Imu"]
            for c, _, raw in r.messages(connections=ic):
                a = ts.deserialize_ros1(raw, c.msgtype).linear_acceleration
                acc.append((a.x, a.y, a.z))
                if len(acc) >= 200:
                    break
    if not acc:
        return np.eye(3)
    up = np.mean(acc, 0)
    up /= np.linalg.norm(up)
    z = np.array([0, 0, 1.0])
    v = np.cross(up, z)
    s, c = np.linalg.norm(v), up @ z
    if s < 1e-9:
        return np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / s**2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--tmp")
    ap.add_argument("--voxel", type=float, default=0.03)
    ap.add_argument("--min-range", type=float, default=1.0)
    ap.add_argument("--max-range", type=float, default=60.0)
    args = ap.parse_args()

    bags = find_bags(args.input)
    ts = make_typestore(bags)
    cal_file = next(Path(args.input).rglob("calibration.yaml"), None)
    cal = yaml.safe_load(open(cal_file)) if cal_file else {}
    cam = Camera(cal) if cal and "camera_info" in cal and "extrin_lidar_camera" in cal else None

    with Reader(bags[0]) as r:
        conns = r.connections
        lidar = next((c.topic for c in conns if c.msgtype.startswith("livox_ros_driver")), None) or \
            next((c.topic for c in conns if c.msgtype == "sensor_msgs/msg/PointCloud2"), None)
        cams = [c.topic for c in conns if c.msgtype == "sensor_msgs/msg/CompressedImage"]
    if not lidar:
        raise SystemExit("No LiDAR topic (Livox CustomMsg or PointCloud2) found in bags")
    cam_topic = next((t for t in cams if "front" in t), None) or next((t for t in cams if "left" in t), None) or \
        (cams[0] if cams else None)
    if cam is None:
        cam_topic = None
    report(0.0, f"Mapping {len(bags)} bag(s), LiDAR {lidar}" + (f", colour from {cam_topic}" if cam_topic else ""))

    cfg = KISSConfig()
    cfg.data.max_range = args.max_range
    cfg.data.min_range = args.min_range
    cfg.data.deskew = True
    cfg.mapping.voxel_size = 0.4
    odo = KissICP(cfg)

    tmp = Path(args.tmp or tempfile.mkdtemp(prefix="bag2e57_"))
    tmp.mkdir(parents=True, exist_ok=True)
    img = None
    V = args.voxel
    for bi, bag in enumerate(bags):
        buf = []
        with Reader(bag) as r:
            cs = [c for c in r.connections if c.topic == lidar or c.topic == cam_topic]
            for c, _, raw in r.messages(connections=cs):
                if c.topic == cam_topic:
                    img = raw
                    continue
                if c.msgtype.startswith("livox_ros_driver"):
                    st, xyz, inten, t = decode_livox(raw)
                else:
                    st, xyz, inten, t = decode_pc2(ts, raw, c.msgtype)
                if len(xyz) < 100:
                    continue
                if t is None or np.ptp(t) == 0:
                    t = np.zeros(len(xyz))
                else:
                    t = (t - t.min()) / np.ptp(t)
                odo.register_frame(xyz, t)
                T = odo.last_pose
                d = np.linalg.norm(xyz, axis=1)
                keep = (d > args.min_range) & (d < args.max_range)
                xyz, inten = xyz[keep], inten[keep]
                rgb = np.zeros((len(xyz), 3), np.uint8)
                has = np.zeros(len(xyz), bool)
                if img is not None and cam is not None:
                    _, jpg = decode_jpeg(img)
                    im = np.asarray(Image.open(io.BytesIO(jpg)).convert("RGB"))
                    u, v, ok = cam.project(xyz)
                    rgb[ok] = im[v[ok].astype(int), u[ok].astype(int)]
                    has = ok
                w = (xyz @ T[:3, :3].T + T[:3, 3]).astype(np.float32)
                buf.append((w, rgb, np.clip(inten, 0, 255).astype(np.uint8), has))
        if buf:
            w = np.concatenate([b[0] for b in buf]); rgb = np.concatenate([b[1] for b in buf])
            it = np.concatenate([b[2] for b in buf]); has = np.concatenate([b[3] for b in buf])
            q = np.floor(w / V).astype(np.int64) + (1 << 20)
            key = (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]
            o = np.lexsort((~has, key)); k = key[o]; first = np.r_[True, k[1:] != k[:-1]]; o = o[first]
            np.savez(tmp / f"{bi:05d}.npz", key=k[first], xyz=w[o], rgb=rgb[o], inten=it[o], has=has[o])
        report(0.9 * (bi + 1) / len(bags), f"Mapped {bi + 1}/{len(bags)} bags")

    # Merge chunks: one point per voxel over the whole run, preferring camera-coloured points
    report(0.9, "Merging map")
    files = sorted(tmp.glob("*.npz"))
    if not files:
        raise SystemExit("No LiDAR points decoded")
    keys, hs, sizes = [], [], []
    for f in files:
        d = np.load(f); keys.append(d["key"]); hs.append(d["has"]); sizes.append(len(d["key"]))
    key = np.concatenate(keys); hs = np.concatenate(hs); del keys
    o = np.lexsort((~hs, key)); k = key[o]
    sel = np.zeros(len(key), bool); sel[o[np.r_[True, k[1:] != k[:-1]]]] = True
    del key, k, o, hs
    off = np.r_[0, np.cumsum(sizes)]
    xyz, rgb, it, has = [], [], [], []
    for i, f in enumerate(files):
        d = np.load(f); m = sel[off[i]:off[i + 1]]
        xyz.append(d["xyz"][m]); rgb.append(d["rgb"][m]); it.append(d["inten"][m]); has.append(d["has"][m])
    xyz = np.concatenate(xyz).astype(np.float64); rgb = np.concatenate(rgb)
    it = np.concatenate(it); has = np.concatenate(has)
    xyz = xyz @ gravity_rotation(bags, ts).T
    rgb[~has] = np.repeat(it[~has, None], 3, 1)  # outside camera view: greyscale reflectivity

    report(0.95, f"Writing E57 ({len(xyz):,} points)")
    out = Path(args.output)
    part = out.with_suffix(".e57.part")
    part.unlink(missing_ok=True)
    e = pye57.E57(str(part), mode="w")
    e.write_scan_raw({
        "cartesianX": xyz[:, 0], "cartesianY": xyz[:, 1], "cartesianZ": xyz[:, 2],
        "intensity": (it / 255.0).astype(np.float32),
        "colorRed": np.ascontiguousarray(rgb[:, 0]), "colorGreen": np.ascontiguousarray(rgb[:, 1]),
        "colorBlue": np.ascontiguousarray(rgb[:, 2]),
    }, name=Path(args.input).name)
    e.close()
    os.replace(part, out)
    if not args.tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    report(1.0, f"Done: {len(xyz):,} points, {has.mean():.0%} camera-coloured")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(str(e.code), file=sys.stderr)
            sys.exit(1)
