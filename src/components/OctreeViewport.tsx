/**
 * Viewport for large uploaded scans: streams a level-of-detail octree and
 * renders round, screen-sized points with Eye-Dome Lighting (EDL) so dense
 * clouds read as continuous surfaces rather than blocks.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RotateCcw, Ruler, Loader2 } from 'lucide-react';
import { LidarFilterState, LidarMetadata, LidarRenderSettings, EditingMode } from '../types/lidar';
import { sampleColormap } from '../utils/colormaps';
import { OctreeHierarchy, StreamingPointCloud } from '../utils/octree';

interface OctreeViewportProps {
  hierarchy: OctreeHierarchy;
  binUrl: string;
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  editingMode: EditingMode;
}

const POINT_VERT = /* glsl */ `
  attribute vec3 rgb;
  attribute float intensity;
  uniform float uPointScale;       // user multiplier on adaptive size
  uniform float uMinSize;          // px (device)
  uniform float uMaxSize;          // px (device)
  uniform float uProjFactor;       // device px per world unit at distance 1
  uniform float uOctreeSize;       // root cube edge (m)
  uniform float uSpacingDiv;       // grid cells per node edge
  uniform float uMinSpacing;       // source data spacing (m)
  uniform sampler2D uVisibleNodes;
  uniform float uVnStart;
  uniform float uLevel;
  uniform int uColorMode;          // 0 rgb, 1 intensity, 2 elevation
  uniform sampler2D uColormap;
  uniform vec2 uElevation;         // colormap range
  uniform vec2 uClipZ;
  uniform vec2 uClipIntensity;
  uniform bool uBoxOn;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxMax;
  varying vec3 vColor;
  varying float vLogDepth;

  bool bitSet(float mask, float i) { return mod(floor(mask / exp2(i) + 0.001), 2.0) > 0.5; }
  float onesBelow(float mask, float i) {
    float n = 0.0;
    for (float k = 0.0; k < 8.0; k++) { if (k >= i) break; if (bitSet(mask, k)) n++; }
    return n;
  }
  // Deepest visible octree level at this point (walks the visible-node texture).
  // Returns -1 where no finer data exists at all (isolated/edge points).
  float adaptiveLevel(vec3 q) {
    float idx = uVnStart;
    float depth = uLevel;
    for (int i = 0; i < 24; i++) {
      vec3 c = step(0.5, q);
      float child = c.x * 4.0 + c.y * 2.0 + c.z;
      vec4 v = texture2D(uVisibleNodes, vec2((idx + 0.5) / ${2048}.0, 0.5));
      float mask = floor(v.r * 255.0 + 0.5);
      if (!bitSet(mask, child)) {
        if (!bitSet(floor(v.a * 255.0 + 0.5), child)) return -1.0;
        break;
      }
      idx += floor(v.g * 255.0 + 0.5) * 256.0 + floor(v.b * 255.0 + 0.5) + onesBelow(mask, child);
      depth += 1.0;
      q = q * 2.0 - c;
    }
    return depth;
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    bool clipped = world.z < uClipZ.x || world.z > uClipZ.y
      || intensity < uClipIntensity.x || intensity > uClipIntensity.y
      || (uBoxOn && (any(lessThan(world.xyz, uBoxMin)) || any(greaterThan(world.xyz, uBoxMax))));
    if (clipped) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    float level = adaptiveLevel(position);
    float spacing = level < 0.0 ? uMinSpacing : max(uOctreeSize / exp2(level) / uSpacingDiv, uMinSpacing);
    gl_PointSize = clamp(uPointScale * spacing * uProjFactor / -mv.z, uMinSize, uMaxSize);
    vLogDepth = log2(max(-mv.z, 0.0625)) + 4.0;   // > 0; 0 marks background for EDL
    if (uColorMode == 1) {
      vColor = vec3(pow(intensity, 0.6));
    } else if (uColorMode == 2) {
      float t = clamp((world.z - uElevation.x) / max(uElevation.y - uElevation.x, 1e-3), 0.0, 1.0);
      vColor = texture2D(uColormap, vec2(t, 0.5)).rgb;
    } else {
      vColor = rgb;
    }
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vLogDepth;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;          // round points
    gl_FragColor = vec4(vColor, vLogDepth);
  }
`;

// Eye-Dome Lighting (Boucheny 2009, as in Potree/CloudCompare): darken pixels
// that are further away than their screen neighbours to reveal shape.
const EDL_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uScreen;
  uniform float uStrength;
  uniform float uRadius;
  uniform bool uEnabled;
  uniform vec3 uBackground;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    if (c.a == 0.0) { gl_FragColor = vec4(uBackground, 1.0); return; }
    float shade = 1.0;
    if (uEnabled) {
      float sum = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * uRadius / uScreen;
        float d = texture2D(tColor, uv).a;
        if (d != 0.0) sum += max(0.0, c.a - d);
      }
      shade = exp(-(sum / 8.0) * 300.0 * uStrength);
    }
    gl_FragColor = vec4(c.rgb * shade, 1.0);
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function colormapTexture(settings: LidarRenderSettings) {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = sampleColormap(i / 255, settings.colormap, settings.invertColormap);
    data.set([r * 255, g * 255, b * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export const OctreeViewport: React.FC<OctreeViewportProps> = ({
  hierarchy,
  binUrl,
  metadata,
  filterState,
  renderSettings,
  editingMode
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    cloud: StreamingPointCloud;
    material: THREE.ShaderMaterial;
    edl: THREE.ShaderMaterial;
    requestRender: () => void;
    frame: (preset: 'reset' | 'top' | 'front' | 'side') => void;
  } | null>(null);
  const [stats, setStats] = useState({ points: 0, nodes: 0, loading: 0 });
  const [measure, setMeasure] = useState<{ a: THREE.Vector3; b?: THREE.Vector3 } | null>(null);
  const measureLine = useRef<THREE.Line | null>(null);

  // Scene setup, once per cloud
  useEffect(() => {
    const container = containerRef.current!;
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const dpr = renderer.getPixelRatio();

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 20000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.98;

    const material = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        uPointScale: { value: 1.2 },
        uMinSize: { value: 1.5 * dpr },
        uMaxSize: { value: 20 * dpr },
        uMinSpacing: { value: 0 },
        uProjFactor: { value: 1 },
        uOctreeSize: { value: hierarchy.cube.size },
        uSpacingDiv: { value: hierarchy.grid },
        uVisibleNodes: { value: null as THREE.Texture | null },
        uVnStart: { value: 0 },
        uLevel: { value: 0 },
        uColorMode: { value: 0 },
        uColormap: { value: colormapTexture(renderSettings) },
        uElevation: { value: new THREE.Vector2(metadata.bounds.minZ, metadata.bounds.maxZ) },
        uClipZ: { value: new THREE.Vector2(-1e9, 1e9) },
        uClipIntensity: { value: new THREE.Vector2(0, 1) },
        uBoxOn: { value: false },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() }
      }
    });

    const scene = new THREE.Scene();
    const cloud = new StreamingPointCloud(hierarchy, binUrl, material);
    material.uniforms.uVisibleNodes.value = cloud.visibleNodesTexture;
    material.uniforms.uMinSpacing.value = cloud.dataSpacing;
    scene.add(cloud.group);

    // EDL: points render into a float target (rgb + log depth), then a full-screen pass shades them
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: true });
    const edl = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: EDL_FRAG,
      uniforms: {
        tColor: { value: target.texture },
        uScreen: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: 1 },
        uRadius: { value: 1.4 * dpr },
        uEnabled: { value: true },
        uBackground: { value: new THREE.Color(renderSettings.backgroundColor) }
      },
      depthTest: false,
      depthWrite: false
    });
    const quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edl));
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    let dirty = true;
    const requestRender = () => { dirty = true; };
    cloud.onNodeLoaded = requestRender;
    controls.addEventListener('change', requestRender);

    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      material.uniforms.uProjFactor.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      target.setSize(w * dpr, h * dpr);
      edl.uniforms.uScreen.value.set(w * dpr, h * dpr);
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    const b = metadata.bounds;
    const center = new THREE.Vector3(b.centerX, b.centerY, b.centerZ);
    const extent = Math.max(b.sizeX, b.sizeY, b.sizeZ);
    const frame = (preset: 'reset' | 'top' | 'front' | 'side') => {
      const d = extent * 0.9;
      const dir =
        preset === 'top' ? new THREE.Vector3(0, -0.001, 1)
        : preset === 'front' ? new THREE.Vector3(0, -1, 0.05)
        : preset === 'side' ? new THREE.Vector3(1, 0, 0.05)
        : new THREE.Vector3(-0.6, -0.8, 0.7);
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(dir.normalize(), d);
      controls.update();
      requestRender();
    };
    frame('reset');

    // Refine until point spacing is about this many CSS pixels
    const lodPixels = 1.6;
    let raf = 0;
    let statTick = 0;
    const renderFrame = () => {
      cloud.update(camera, container.clientHeight, lodPixels);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      // Keep refining while nodes stream in, even if the camera is still
      if (dirty || cloud.pendingLoads > 0) {
        dirty = false;
        renderFrame();
      }
      if (++statTick % 15 === 0) {
        setStats({ points: cloud.visiblePoints, nodes: cloud.visibleNodes, loading: cloud.pendingLoads });
      }
    };
    loop();

    ctx.current = { renderer, camera, controls, cloud, material, edl, requestRender, frame };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      cloud.dispose();
      material.dispose();
      edl.dispose();
      target.dispose();
      renderer.dispose();
      ctx.current = null;
    };
  }, [hierarchy, binUrl]);

  // Shading settings
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const u = c.material.uniforms;
    // Slider 1-8: scales the adaptive point size (2 = default)
    u.uPointScale.value = 1.2 * (renderSettings.pointSize / 2);
    u.uColorMode.value =
      renderSettings.colorMode === 'intensity' ? 1 : renderSettings.colorMode === 'elevation' ? 2 : hierarchy.hasColor ? 0 : 2;
    u.uColormap.value.dispose();
    u.uColormap.value = colormapTexture(renderSettings);
    c.edl.uniforms.uEnabled.value = renderSettings.edlEnabled;
    c.edl.uniforms.uStrength.value = renderSettings.edlStrength;
    c.edl.uniforms.uRadius.value = renderSettings.edlRadius * c.renderer.getPixelRatio();
    c.edl.uniforms.uBackground.value.set(renderSettings.backgroundColor);
    c.requestRender();
  }, [renderSettings, hierarchy]);

  // Filters: elevation / intensity slices and ROI box run on the GPU
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const u = c.material.uniforms;
    u.uClipZ.value.set(filterState.elevationMin, filterState.elevationMax);
    u.uClipIntensity.value.set(filterState.intensityMin / 65535, filterState.intensityMax / 65535);
    u.uBoxOn.value = filterState.cropBoxEnabled;
    u.uBoxMin.value.set(...filterState.cropBoxMin);
    u.uBoxMax.value.set(...filterState.cropBoxMax);
    c.cloud.pointBudget = Math.round(8_000_000 * Math.max(0.1, filterState.decimationRate));
    c.requestRender();
  }, [filterState]);

  // Measurement line
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const scene = c.cloud.group;
    if (measureLine.current) {
      scene.remove(measureLine.current);
      measureLine.current.geometry.dispose();
      measureLine.current = null;
    }
    if (measure?.b) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([measure.a, measure.b]),
        new THREE.LineBasicMaterial({ color: 0xe87d0d })
      );
      scene.add(line);
      measureLine.current = line;
    }
    c.requestRender();
  }, [measure]);

  useEffect(() => {
    if (editingMode !== 'measure') setMeasure(null);
  }, [editingMode]);

  // Double-click re-centres the orbit on the clicked point; in measure mode clicks pick points
  const pickAt = (e: React.MouseEvent) => {
    const c = ctx.current;
    if (!c) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, c.camera);
    const pxAngle = (THREE.MathUtils.degToRad(c.camera.fov) / rect.height) * Math.max(3, renderSettings.pointSize);
    return c.cloud.pick(ray.ray, Math.tan(pxAngle));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = pickAt(e);
    const c = ctx.current;
    if (!p || !c) return;
    const offset = c.camera.position.clone().sub(c.controls.target);
    c.controls.target.copy(p);
    c.camera.position.copy(p).add(offset.multiplyScalar(0.6));
    c.controls.update();
    c.requestRender();
  };

  const onClick = (e: React.MouseEvent) => {
    if (editingMode !== 'measure') return;
    const p = pickAt(e);
    if (!p) return;
    setMeasure(m => (!m || m.b ? { a: p } : { a: m.a, b: p }));
  };

  const m = measure?.b
    ? (() => {
        const d = measure.b!.clone().sub(measure.a);
        const horiz = Math.hypot(d.x, d.y);
        return { d3: d.length(), horiz, dz: d.z, slope: horiz > 0 ? (d.z / horiz) * 100 : 0 };
      })()
    : null;

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden select-none" onContextMenu={e => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
        className={`w-full h-full block ${editingMode === 'measure' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      />

      <div className="absolute top-3 left-3 flex items-center gap-1.5 z-10">
        <div className="flex items-center bg-[#1a1c24]/90 backdrop-blur border border-[#2e3140] rounded-md px-1.5 py-1 text-xs text-gray-300 gap-1 shadow-lg font-mono">
          {(['top', 'front', 'side'] as const).map(p => (
            <button
              key={p}
              onClick={() => ctx.current?.frame(p)}
              className="px-2 py-0.5 rounded text-[11px] hover:bg-[#2c303f] text-gray-400 hover:text-white transition-colors"
            >
              {p === 'top' ? 'Top (Map)' : p === 'front' ? 'Front' : 'Side'}
            </button>
          ))}
          <div className="h-3 w-px bg-gray-700" />
          <button
            onClick={() => ctx.current?.frame('reset')}
            title="Reset view"
            className="p-1 hover:bg-[#2c303f] text-gray-400 hover:text-white rounded"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
        {editingMode === 'measure' && (
          <div className="flex items-center gap-1.5 bg-[#e87d0d]/20 border border-[#e87d0d]/50 text-[#e87d0d] px-2.5 py-1 rounded-md text-xs font-medium backdrop-blur">
            <Ruler className="w-3.5 h-3.5" />
            <span>Click 2 points to measure</span>
          </div>
        )}
      </div>

      {m && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-[#1b1d28]/95 backdrop-blur border border-amber-500/50 rounded-xl px-4 py-2.5 text-xs shadow-2xl flex items-center gap-4 z-20 font-mono">
          <span className="text-amber-400 font-bold">3D: {m.d3.toFixed(3)} m</span>
          <span className="text-gray-300">Horizontal: {m.horiz.toFixed(3)} m</span>
          <span className="text-gray-300">ΔZ: {m.dz.toFixed(3)} m</span>
          <span className="text-gray-300">Slope: {m.slope.toFixed(1)}%</span>
          <button onClick={() => setMeasure(null)} className="text-gray-400 hover:text-white underline">Clear</button>
        </div>
      )}

      <div className="absolute bottom-3 left-3 text-[11px] font-mono text-gray-400 bg-[#161820]/90 backdrop-blur px-3 py-1.5 rounded-lg border border-[#2b2e3d] pointer-events-none space-y-0.5 z-10 shadow-lg">
        <div className="flex items-center gap-2 text-gray-200 font-semibold">
          {stats.loading > 0 ? (
            <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
          )}
          <span>Rendered: {stats.points.toLocaleString()} pts</span>
          <span className="text-gray-600">/</span>
          <span className="text-gray-400">{metadata.pointCount.toLocaleString()} total</span>
        </div>
        <div className="text-[10px] text-gray-500 flex items-center gap-2">
          <span>Streaming LOD · {stats.nodes} nodes{stats.loading > 0 ? ` · loading ${stats.loading}` : ''}</span>
          <span>·</span>
          <span>{metadata.bounds.sizeX.toFixed(1)} × {metadata.bounds.sizeY.toFixed(1)} m</span>
        </div>
        <div className="text-[10px] text-gray-600">Drag orbit · Right-drag pan · Scroll zoom to cursor · Double-click to focus</div>
      </div>
    </div>
  );
};
