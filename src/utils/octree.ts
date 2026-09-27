/**
 * Streaming level-of-detail point cloud (client side of server/pointcloud/octree.ts).
 *
 * Each frame the visible node set is chosen by projected point spacing, within
 * a point budget; missing nodes are fetched with HTTP range requests and
 * uploaded as GPU buffers. Positions stay uint16-quantised on the GPU and are
 * placed by each node's transform, so no per-point CPU decoding is needed.
 */

import * as THREE from 'three';

export interface OctreeHierarchy {
  version: number;
  grid: number;
  pointCount: number;
  depth: number;
  origin: [number, number, number];
  cube: { min: [number, number, number]; size: number };
  bounds: { min: [number, number, number]; max: [number, number, number] };
  hasColor: boolean;
  hasIntensity: boolean;
  nodes: [string, number, number, number][]; // name, points, byteOffset, byteLength
}

export interface OctreeNode {
  name: string;
  level: number;
  count: number;
  offset: number;
  bytes: number;
  min: THREE.Vector3;
  size: number;
  box: THREE.Box3;
  center: THREE.Vector3;
  children: OctreeNode[];
  points: THREE.Points | null;
  loading: boolean;
  lastUsed: number;
  vnIndex: number; // slot in the visible-node texture this frame
}

export const MAX_VISIBLE_NODES = 2048;

const tmpVec = new THREE.Vector3();

export class StreamingPointCloud {
  readonly group = new THREE.Group();
  readonly root: OctreeNode;
  readonly hierarchy: OctreeHierarchy;
  private readonly all: OctreeNode[] = [];
  private active = 0;
  private frame = 0;
  loadedPoints = 0;
  visiblePoints = 0;
  visibleNodes = 0;
  pendingLoads = 0;
  maxConcurrent = 6;
  pointBudget = 8_000_000;
  memoryBudget = 30_000_000; // points kept on the GPU
  onNodeLoaded?: () => void;
  /** Typical spacing of the source data (m); points are never drawn smaller than this. */
  readonly dataSpacing: number;

  /**
   * Visible-node map for adaptive point sizes (as in Potree): one texel per
   * visible node in breadth-first order, r = mask of visible children,
   * g/b = offset to the first visible child, a = mask of children that exist. The vertex shader walks it to
   * find the deepest visible level at each point and sizes points to match.
   */
  readonly visibleNodesTexture: THREE.DataTexture;

  constructor(hierarchy: OctreeHierarchy, private readonly binUrl: string, private readonly material: THREE.ShaderMaterial) {
    this.visibleNodesTexture = new THREE.DataTexture(new Uint8Array(MAX_VISIBLE_NODES * 4), MAX_VISIBLE_NODES, 1, THREE.RGBAFormat);
    this.visibleNodesTexture.magFilter = THREE.NearestFilter;
    this.visibleNodesTexture.minFilter = THREE.NearestFilter;
    this.hierarchy = hierarchy;
    const byName = new Map<string, OctreeNode>();
    const cubeMin = new THREE.Vector3(...hierarchy.cube.min);
    for (const [name, count, offset, bytes] of hierarchy.nodes) {
      let min = cubeMin.clone();
      let size = hierarchy.cube.size;
      for (let k = 1; k < name.length; k++) {
        size /= 2;
        const c = +name[k];
        min = min.clone().add(new THREE.Vector3(c & 4 ? size : 0, c & 2 ? size : 0, c & 1 ? size : 0));
      }
      const box = new THREE.Box3(min, min.clone().addScalar(size));
      const node: OctreeNode = {
        name, level: name.length - 1, count, offset, bytes, min, size, box,
        center: box.getCenter(new THREE.Vector3()), children: [], points: null, loading: false, lastUsed: 0, vnIndex: 0
      };
      byName.set(name, node);
      this.all.push(node);
    }
    for (const node of this.all) {
      if (node.name !== 'r') byName.get(node.name.slice(0, -1))?.children.push(node);
    }
    this.root = byName.get('r')!;

    // Leaves hold the full-density data: estimate its spacing as edge / sqrt(points)
    const leafSpacing = this.all
      .filter(n => n.children.length === 0 && n.count > 100)
      .map(n => n.size / Math.sqrt(n.count))
      .sort((a, b) => a - b);
    this.dataSpacing = leafSpacing.length ? leafSpacing[Math.floor(leafSpacing.length / 2)] : 0;
  }

  /**
   * Choose visible nodes for this camera. `pointSizePx` is the on-screen point
   * size; nodes are refined until their point spacing is about that small.
   */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, pointSizePx: number) {
    this.frame++;
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );
    const projFactor = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const spacingPx = (n: OctreeNode) => {
      const dist = Math.max(n.box.distanceToPoint(camera.position), n.size * 0.05, 0.05);
      return (n.size / this.hierarchy.grid / dist) * projFactor;
    };

    // Best-first traversal by projected spacing, within the point budget
    const queue: [number, OctreeNode][] = [[Infinity, this.root]];
    const toLoad: [number, OctreeNode][] = [];
    const accepted: OctreeNode[] = [];
    let points = 0, nodes = 0;
    for (const n of this.all) if (n.points) n.points.visible = false;

    while (queue.length) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][0] > queue[best][0]) best = i;
      const [weight, node] = queue.splice(best, 1)[0];
      if (!frustum.intersectsBox(node.box)) continue;
      if (points + node.count > this.pointBudget || accepted.length >= MAX_VISIBLE_NODES) break;
      node.lastUsed = this.frame;
      if (node.count > 0) {
        if (!node.points) {
          toLoad.push([weight, node]);
          continue; // descendants wait for this node's coarser points
        }
        node.points.visible = true;
        points += node.count;
        nodes++;
      }
      accepted.push(node);
      if (spacingPx(node) > pointSizePx * 0.8) {
        for (const c of node.children) queue.push([spacingPx(c), c]);
      }
    }
    this.visiblePoints = points;
    this.visibleNodes = nodes;
    this.writeVisibleNodes(accepted);

    toLoad.sort((a, b) => b[0] - a[0]);
    for (const [, node] of toLoad) {
      if (this.active >= this.maxConcurrent) break;
      if (!node.loading) this.load(node);
    }
    this.pendingLoads = toLoad.length;
    this.evict();
  }

  private writeVisibleNodes(accepted: OctreeNode[]) {
    const ordered = accepted.sort((a, b) => a.level - b.level || (a.name < b.name ? -1 : 1));
    const inSet = new Set(ordered);
    ordered.forEach((n, i) => { n.vnIndex = i; });
    const data = this.visibleNodesTexture.image.data as Uint8Array;
    data.fill(0);
    for (const n of ordered) {
      let mask = 0;
      let exists = 0;
      let first = -1;
      for (const c of n.children) {
        exists |= 1 << +c.name[c.name.length - 1];
        if (!inSet.has(c)) continue;
        const idx = +c.name[c.name.length - 1];
        mask |= 1 << idx;
        if (first < 0 || c.vnIndex < first) first = c.vnIndex;
      }
      const offset = first < 0 ? 0 : first - n.vnIndex;
      data[n.vnIndex * 4] = mask;
      data[n.vnIndex * 4 + 1] = (offset >> 8) & 255;
      data[n.vnIndex * 4 + 2] = offset & 255;
      data[n.vnIndex * 4 + 3] = exists;
    }
    this.visibleNodesTexture.needsUpdate = true;
  }

  private async load(node: OctreeNode) {
    node.loading = true;
    this.active++;
    try {
      const res = await fetch(this.binUrl, {
        headers: { Range: `bytes=${node.offset}-${node.offset + node.bytes - 1}`, 'x-requested-by': 'lidar-web-client' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const n = node.count;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf, 0, n * 3), 3, true));
      geom.setAttribute('intensity', new THREE.BufferAttribute(new Uint16Array(buf, n * 6, n), 1, true));
      geom.setAttribute('rgb', new THREE.BufferAttribute(new Uint8Array(buf, n * 8, n * 3), 3, true));
      geom.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
      const pts = new THREE.Points(geom, this.material);
      pts.position.copy(node.min);
      pts.scale.setScalar(node.size);
      pts.frustumCulled = false;
      pts.visible = false;
      pts.userData.level = node.level;
      // Per-node uniforms for the shared material
      pts.onBeforeRender = () => {
        const u = this.material.uniforms;
        u.uVnStart.value = node.vnIndex;
        u.uLevel.value = node.level;
        this.material.uniformsNeedUpdate = true;
      };
      pts.matrixAutoUpdate = false;
      pts.updateMatrix();
      node.points = pts;
      this.group.add(pts);
      this.loadedPoints += n;
      this.onNodeLoaded?.();
    } catch (err) {
      console.warn(`Failed to load octree node ${node.name}:`, err);
    } finally {
      node.loading = false;
      this.active--;
    }
  }

  /** Drop least-recently-visible nodes once over the GPU memory budget. */
  private evict() {
    if (this.loadedPoints <= this.memoryBudget) return;
    const loaded = this.all.filter(n => n.points && n.lastUsed !== this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const n of loaded) {
      if (this.loadedPoints <= this.memoryBudget * 0.8) break;
      this.group.remove(n.points!);
      n.points!.geometry.dispose();
      n.points = null;
      this.loadedPoints -= n.count;
    }
  }

  /** World-space point nearest the ray among loaded, visible nodes (for picking). */
  pick(ray: THREE.Ray, thresholdPerMeter: number): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestT = Infinity;
    const p = new THREE.Vector3();
    for (const n of this.all) {
      if (!n.points?.visible || !ray.intersectsBox(n.box)) continue;
      const pos = n.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Uint16Array;
      for (let i = 0; i < n.count; i++) {
        p.set(arr[i * 3] / 65535, arr[i * 3 + 1] / 65535, arr[i * 3 + 2] / 65535).multiplyScalar(n.size).add(n.min);
        const t = tmpVec.subVectors(p, ray.origin).dot(ray.direction);
        if (t <= 0 || t >= bestT) continue;
        if (ray.distanceSqToPoint(p) < (thresholdPerMeter * t) ** 2) {
          bestT = t;
          best = p.clone();
        }
      }
    }
    return best;
  }

  dispose() {
    for (const n of this.all) {
      if (n.points) {
        n.points.geometry.dispose();
        n.points = null;
      }
    }
    this.group.clear();
  }
}
