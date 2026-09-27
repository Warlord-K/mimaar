import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import {
  LidarPoint,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  MeasurementResult,
  EditingMode
} from '../types/lidar';
import { ViewportCaptureFn } from '../types/photoreal';
import { sampleColormap, getClassificationColor } from '../utils/colormaps';
import {
  Compass,
  Maximize2,
  Eye,
  Ruler,
  Box,
  Layers,
  Camera,
  Grid,
  RotateCcw,
  Sparkles,
  Sliders
} from 'lucide-react';

interface LidarViewportProps {
  points: LidarPoint[];
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  editingMode: EditingMode;
  onUpdateCropBox?: (min: [number, number, number], max: [number, number, number]) => void;
  onMeasurementChange?: (result: MeasurementResult | null) => void;
  /** Filled with a function that captures the current view (used by Photoreal Studio). */
  captureRef?: React.MutableRefObject<ViewportCaptureFn | null>;
}

export const LidarViewport: React.FC<LidarViewportProps> = ({
  points,
  metadata,
  filterState,
  renderSettings,
  editingMode,
  onUpdateCropBox,
  onMeasurementChange,
  captureRef
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const pointsMeshRef = useRef<THREE.Points | null>(null);
  const cropBoxMeshRef = useRef<THREE.LineSegments | null>(null);
  const measurementLineRef = useRef<THREE.Line | null>(null);

  // Visible point count state for HUD
  const [renderedCount, setRenderedCount] = useState<number>(0);
  const [measurementHud, setMeasurementHud] = useState<MeasurementResult | null>(null);
  const [isOrthoView, setIsOrthoView] = useState<boolean>(false);
  const [viewPreset, setViewPreset] = useState<'free' | 'top' | 'front' | 'side'>('free');

  // Orbit & Pan State
  const isDraggingRef = useRef<boolean>(false);
  const isPanningRef = useRef<boolean>(false);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const orbitRef = useRef({
    theta: Math.PI / 4,
    phi: Math.PI / 3.2,
    radius: 70,
    target: new THREE.Vector3(0, 0, 0)
  });

  // Measurement pick state
  const measurementPointsRef = useRef<THREE.Vector3[]>([]);

  // Initialize Three.js
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(renderSettings.backgroundColor || '#111217');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    cameraRef.current = camera;

    // Ground Reference Grid
    const grid = new THREE.GridHelper(120, 24, 0x484d60, 0x242733);
    grid.position.y = metadata.bounds.minZ - 0.5;
    grid.name = 'lidar_grid';
    scene.add(grid);

    // Initial Camera Positioning centered on point cloud bounds
    const center = new THREE.Vector3(
      metadata.bounds.centerX,
      metadata.bounds.centerY,
      metadata.bounds.centerZ
    );
    orbitRef.current.target.copy(center);
    const maxDim = Math.max(metadata.bounds.sizeX, metadata.bounds.sizeY, metadata.bounds.sizeZ);
    orbitRef.current.radius = Math.max(30, maxDim * 1.5);

    const updateCamera = () => {
      if (!cameraRef.current) return;
      const { theta, phi, radius, target } = orbitRef.current;
      const x = target.x + radius * Math.sin(phi) * Math.sin(theta);
      const y = target.y - radius * Math.sin(phi) * Math.cos(theta);
      const z = target.z + radius * Math.cos(phi);
      cameraRef.current.position.set(x, y, z);
      cameraRef.current.lookAt(target);
    };
    updateCamera();

    // Animation Loop
    let animId: number;
    const loop = () => {
      animId = requestAnimationFrame(loop);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    loop();

    // Resize Observer
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
    };
  }, []);

  // Expose a capture function: renders one frame without helpers (grid, ROI box, ruler) and grabs it as PNG
  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = (maxSide = 1536) => {
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return null;

      const helpers = [scene.getObjectByName('lidar_grid'), cropBoxMeshRef.current, measurementLineRef.current]
        .filter((h): h is THREE.Object3D => !!h);
      const wasVisible = helpers.map(h => h.visible);
      helpers.forEach(h => { h.visible = false; });
      renderer.render(scene, camera);

      const src = renderer.domElement;
      const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
      const out = document.createElement('canvas');
      out.width = Math.round(src.width * scale);
      out.height = Math.round(src.height * scale);
      out.getContext('2d')?.drawImage(src, 0, 0, out.width, out.height);

      helpers.forEach((h, i) => { h.visible = wasVisible[i]; });
      renderer.render(scene, camera);
      return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height };
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef]);

  // Update Background Color
  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(renderSettings.backgroundColor || '#111217');
    }
  }, [renderSettings.backgroundColor]);

  // Center camera when metadata bounds change
  useEffect(() => {
    if (!cameraRef.current) return;
    const center = new THREE.Vector3(
      metadata.bounds.centerX,
      metadata.bounds.centerY,
      metadata.bounds.centerZ
    );
    orbitRef.current.target.copy(center);
    const maxDim = Math.max(metadata.bounds.sizeX, metadata.bounds.sizeY, metadata.bounds.sizeZ);
    orbitRef.current.radius = Math.max(30, maxDim * 1.4);

    const { theta, phi, radius, target } = orbitRef.current;
    cameraRef.current.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y - radius * Math.sin(phi) * Math.cos(theta),
      target.z + radius * Math.cos(phi)
    );
    cameraRef.current.lookAt(target);
  }, [metadata]);

  // Re-build or filter point cloud buffer
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;

    // Filter points in high performance single-pass
    const {
      elevationMin, elevationMax,
      intensityMin, intensityMax,
      enabledClasses,
      cropBoxEnabled, cropBoxMin, cropBoxMax,
      decimationRate
    } = filterState;

    const [iMin, iMax] = metadata.intensityRange;
    const [zMin, zMax] = metadata.elevationRange;
    const zSpan = Math.max(0.001, zMax - zMin);
    const iSpan = Math.max(1, iMax - iMin);

    const stride = decimationRate <= 0.1 ? 10 : decimationRate <= 0.25 ? 4 : decimationRate <= 0.5 ? 2 : 1;

    // Estimate capacity
    const maxPoints = Math.ceil(points.length / stride);
    const posArray = new Float32Array(maxPoints * 3);
    const colArray = new Float32Array(maxPoints * 3);

    let count = 0;
    for (let i = 0; i < points.length; i += stride) {
      const p = points[i];

      // Elevation Filter
      if (p.z < elevationMin || p.z > elevationMax) continue;

      // Intensity Filter
      const intens = p.intensity ?? 0;
      if (intens < intensityMin || intens > intensityMax) continue;

      // Classification Filter
      const cls = p.classification ?? 1;
      if (enabledClasses.size > 0 && !enabledClasses.has(cls)) continue;

      // Box Crop ROI
      if (cropBoxEnabled) {
        if (
          p.x < cropBoxMin[0] || p.x > cropBoxMax[0] ||
          p.y < cropBoxMin[1] || p.y > cropBoxMax[1] ||
          p.z < cropBoxMin[2] || p.z > cropBoxMax[2]
        ) {
          continue;
        }
      }

      // Add to buffer
      posArray[count * 3] = p.x;
      posArray[count * 3 + 1] = p.y;
      posArray[count * 3 + 2] = p.z;

      // Compute Color
      let r = 0.8, g = 0.8, b = 0.8;
      if (renderSettings.colorMode === 'elevation') {
        const normZ = (p.z - zMin) / zSpan;
        [r, g, b] = sampleColormap(normZ, renderSettings.colormap, renderSettings.invertColormap);
      } else if (renderSettings.colorMode === 'intensity') {
        const normI = (intens - iMin) / iSpan;
        if (renderSettings.colormap === 'turbo') {
          [r, g, b] = sampleColormap(normI, 'turbo', renderSettings.invertColormap);
        } else {
          // Greyscale intensity
          const grey = Math.max(0, Math.min(1, normI));
          r = g = b = grey;
        }
      } else if (renderSettings.colorMode === 'classification') {
        const [cr, cg, cb] = getClassificationColor(cls);
        r = cr / 255;
        g = cg / 255;
        b = cb / 255;
      } else if (renderSettings.colorMode === 'rgb' && p.r !== undefined && p.g !== undefined && p.b !== undefined) {
        r = p.r / 255;
        g = p.g / 255;
        b = p.b / 255;
      } else if (renderSettings.colorMode === 'returns') {
        // Multi-return color
        const ret = p.returnNumber ?? 1;
        if (ret === 1) { r = 0.2; g = 0.8; b = 1.0; } // First return
        else if (ret === 2) { r = 1.0; g = 0.8; b = 0.2; } // Intermediate
        else { r = 1.0; g = 0.2; b = 0.3; } // Last return
      }

      colArray[count * 3] = r;
      colArray[count * 3 + 1] = g;
      colArray[count * 3 + 2] = b;

      count++;
    }

    setRenderedCount(count);

    // Update Three.js geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(posArray.subarray(0, count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colArray.subarray(0, count * 3), 3));

    // Points Material
    const material = new THREE.PointsMaterial({
      size: renderSettings.pointSize,
      vertexColors: true,
      sizeAttenuation: renderSettings.sizeAttenuation,
      transparent: false
    });

    if (pointsMeshRef.current) {
      scene.remove(pointsMeshRef.current);
      pointsMeshRef.current.geometry.dispose();
      (pointsMeshRef.current.material as THREE.Material).dispose();
    }

    const pointsMesh = new THREE.Points(geometry, material);
    scene.add(pointsMesh);
    pointsMeshRef.current = pointsMesh;
  }, [points, metadata, filterState, renderSettings]);

  // Update Crop Box ROI Wireframe in 3D Scene
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;

    if (cropBoxMeshRef.current) {
      scene.remove(cropBoxMeshRef.current);
      cropBoxMeshRef.current.geometry.dispose();
      cropBoxMeshRef.current = null;
    }

    if (filterState.cropBoxEnabled) {
      const min = filterState.cropBoxMin;
      const max = filterState.cropBoxMax;

      const sizeX = Math.max(0.1, max[0] - min[0]);
      const sizeY = Math.max(0.1, max[1] - min[1]);
      const sizeZ = Math.max(0.1, max[2] - min[2]);

      const boxGeom = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
      const edges = new THREE.EdgesGeometry(boxGeom);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        linewidth: 2
      });

      const boxMesh = new THREE.LineSegments(edges, lineMat);
      boxMesh.position.set(
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2
      );
      scene.add(boxMesh);
      cropBoxMeshRef.current = boxMesh;
    }
  }, [filterState.cropBoxEnabled, filterState.cropBoxMin, filterState.cropBoxMax]);

  // Handle Mouse Click & Drag
  const handleMouseDown = (e: React.MouseEvent) => {
    if (editingMode === 'measure' && e.button === 0) {
      // Pick 3D point for measurement
      handlePickMeasurementPoint(e);
      return;
    }

    if (e.button === 0) {
      // Left click orbit
      isDraggingRef.current = true;
    } else if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      // Pan
      isPanningRef.current = true;
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const deltaX = e.clientX - lastMousePosRef.current.x;
    const deltaY = e.clientY - lastMousePosRef.current.y;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    if (isDraggingRef.current) {
      const orbit = orbitRef.current;
      orbit.theta -= deltaX * 0.007;
      orbit.phi = Math.max(0.02, Math.min(Math.PI - 0.02, orbit.phi - deltaY * 0.007));

      if (cameraRef.current) {
        const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
        const y = orbit.target.y - orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
        const z = orbit.target.z + orbit.radius * Math.cos(orbit.phi);
        cameraRef.current.position.set(x, y, z);
        cameraRef.current.lookAt(orbit.target);
      }
    } else if (isPanningRef.current) {
      const panSpeed = orbitRef.current.radius * 0.0015;
      const orbit = orbitRef.current;
      const right = new THREE.Vector3(Math.cos(orbit.theta), Math.sin(orbit.theta), 0);
      const up = new THREE.Vector3(0, 0, 1);

      orbit.target.addScaledVector(right, -deltaX * panSpeed);
      orbit.target.addScaledVector(up, deltaY * panSpeed);

      if (cameraRef.current) {
        const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
        const y = orbit.target.y - orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
        const z = orbit.target.z + orbit.radius * Math.cos(orbit.phi);
        cameraRef.current.position.set(x, y, z);
        cameraRef.current.lookAt(orbit.target);
      }
    }
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    isPanningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    const zoomDelta = e.deltaY * 0.0015 * orbitRef.current.radius;
    orbitRef.current.radius = Math.max(2.0, Math.min(500, orbitRef.current.radius + zoomDelta));

    if (cameraRef.current) {
      const orbit = orbitRef.current;
      const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
      const y = orbit.target.y - orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
      const z = orbit.target.z + orbit.radius * Math.cos(orbit.phi);
      cameraRef.current.position.set(x, y, z);
      cameraRef.current.lookAt(orbit.target);
    }
  };

  // 3D Measurement Raycast Pick
  const handlePickMeasurementPoint = (e: React.MouseEvent) => {
    if (!containerRef.current || !cameraRef.current || !pointsMeshRef.current || !sceneRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: renderSettings.pointSize * 0.4 };
    raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), cameraRef.current);

    const intersects = raycaster.intersectObject(pointsMeshRef.current);
    if (intersects.length > 0) {
      const hitPoint = intersects[0].point;
      const pts = measurementPointsRef.current;

      if (pts.length >= 2) {
        pts.length = 0; // reset
      }
      pts.push(hitPoint.clone());

      // Update 3D measurement line
      if (measurementLineRef.current) {
        sceneRef.current.remove(measurementLineRef.current);
        measurementLineRef.current.geometry.dispose();
      }

      if (pts.length === 2) {
        const p1 = pts[0];
        const p2 = pts[1];

        const lineGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        const lineMat = new THREE.LineDashedMaterial({
          color: 0xffd700,
          dashSize: 0.5,
          gapSize: 0.25,
          linewidth: 2
        });
        const line = new THREE.Line(lineGeom, lineMat);
        line.computeLineDistances();
        sceneRef.current.add(line);
        measurementLineRef.current = line;

        // Calculate metrics
        const dist3D = p1.distanceTo(p2);
        const distHoriz = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
        const deltaZ = p2.z - p1.z;
        const slopePercent = distHoriz > 0 ? (Math.abs(deltaZ) / distHoriz) * 100 : 999;

        const res: MeasurementResult = {
          p1: { x: p1.x, y: p1.y, z: p1.z },
          p2: { x: p2.x, y: p2.y, z: p2.z },
          distance3D: Number(dist3D.toFixed(3)),
          distanceHorizontal: Number(distHoriz.toFixed(3)),
          deltaZ: Number(deltaZ.toFixed(3)),
          slopePercent: Number(slopePercent.toFixed(1))
        };
        setMeasurementHud(res);
        if (onMeasurementChange) onMeasurementChange(res);
      }
    }
  };

  // Camera Presets
  const setCameraPreset = (preset: 'top' | 'front' | 'side' | 'reset') => {
    setViewPreset(preset === 'reset' ? 'free' : preset);
    const orbit = orbitRef.current;

    if (preset === 'top') {
      orbit.theta = 0;
      orbit.phi = 0.001; // directly overhead map view
    } else if (preset === 'front') {
      orbit.theta = 0;
      orbit.phi = Math.PI / 2; // elevation profile view
    } else if (preset === 'side') {
      orbit.theta = Math.PI / 2;
      orbit.phi = Math.PI / 2; // side cross-section
    } else if (preset === 'reset') {
      orbit.target.set(metadata.bounds.centerX, metadata.bounds.centerY, metadata.bounds.centerZ);
      const maxDim = Math.max(metadata.bounds.sizeX, metadata.bounds.sizeY, metadata.bounds.sizeZ);
      orbit.radius = Math.max(30, maxDim * 1.4);
      orbit.theta = Math.PI / 4;
      orbit.phi = Math.PI / 3.2;
    }

    if (cameraRef.current) {
      const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
      const y = orbit.target.y - orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
      const z = orbit.target.z + orbit.radius * Math.cos(orbit.phi);
      cameraRef.current.position.set(x, y, z);
      cameraRef.current.lookAt(orbit.target);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-[#111217] overflow-hidden select-none outline-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={e => e.preventDefault()}
    >
      {/* 3D WebGL Canvas */}
      <canvas
        ref={canvasRef}
        className={`w-full h-full block ${
          editingMode === 'measure' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        }`}
      />

      {/* Top Left: Orthographic / Presets Bar */}
      <div className="absolute top-3 left-3 flex items-center gap-1.5 z-10">
        <div className="flex items-center bg-[#1a1c24]/90 backdrop-blur border border-[#2e3140] rounded-md px-1.5 py-1 text-xs text-gray-300 gap-1 shadow-lg font-mono">
          <button
            onClick={() => setCameraPreset('top')}
            title="Map View (Overhead Top)"
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              viewPreset === 'top' ? 'bg-[#3b82f6] text-white' : 'hover:bg-[#2c303f] text-gray-400'
            }`}
          >
            Top (Map)
          </button>
          <button
            onClick={() => setCameraPreset('front')}
            title="Front Elevation Profile"
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              viewPreset === 'front' ? 'bg-[#3b82f6] text-white' : 'hover:bg-[#2c303f] text-gray-400'
            }`}
          >
            Profile (Front)
          </button>
          <button
            onClick={() => setCameraPreset('side')}
            title="Side Section"
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              viewPreset === 'side' ? 'bg-[#3b82f6] text-white' : 'hover:bg-[#2c303f] text-gray-400'
            }`}
          >
            Side
          </button>
          <div className="h-3 w-px bg-gray-700" />
          <button
            onClick={() => setCameraPreset('reset')}
            title="Reset View to Cloud Center"
            className="p-1 hover:bg-[#2c303f] text-gray-400 hover:text-white rounded"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Active Tool Badge */}
        {editingMode === 'measure' && (
          <div className="flex items-center gap-1.5 bg-[#e87d0d]/20 border border-[#e87d0d]/50 text-[#e87d0d] px-2.5 py-1 rounded-md text-xs font-medium backdrop-blur">
            <Ruler className="w-3.5 h-3.5" />
            <span>Click 2 points to measure 3D distance & slope</span>
          </div>
        )}

        {filterState.cropBoxEnabled && (
          <div className="flex items-center gap-1.5 bg-[#00f0ff]/15 border border-[#00f0ff]/40 text-[#00f0ff] px-2.5 py-1 rounded-md text-xs font-medium backdrop-blur">
            <Box className="w-3.5 h-3.5" />
            <span>ROI Box Crop Active</span>
          </div>
        )}
      </div>

      {/* Top Right: Colormap Legend */}
      <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2">
        {renderSettings.colorMode === 'elevation' && (
          <div className="bg-[#181922]/90 backdrop-blur border border-[#2d3040] rounded-lg p-2.5 text-xs shadow-xl w-44">
            <div className="flex items-center justify-between text-[11px] text-gray-400 font-mono mb-1">
              <span>Elevation (Z)</span>
              <span className="text-amber-400 font-bold uppercase">{renderSettings.colormap}</span>
            </div>
            {/* Color Gradient Strip */}
            <div
              className="h-3 rounded w-full border border-gray-700 shadow-inner"
              style={{
                background:
                  renderSettings.colormap === 'viridis'
                    ? 'linear-gradient(to right, #440154, #3b528b, #21908d, #5dc863, #fde725)'
                    : renderSettings.colormap === 'turbo'
                    ? 'linear-gradient(to right, #30123b, #4582ec, #32d667, #e1dc32, #d13008)'
                    : renderSettings.colormap === 'terrain'
                    ? 'linear-gradient(to right, #267340, #59b34d, #b3a626, #bfa640, #ffffff)'
                    : 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)'
              }}
            />
            <div className="flex items-center justify-between text-[10px] text-gray-400 font-mono mt-1">
              <span>{metadata.bounds.minZ.toFixed(1)}m</span>
              <span>{((metadata.bounds.minZ + metadata.bounds.maxZ) / 2).toFixed(1)}m</span>
              <span>{metadata.bounds.maxZ.toFixed(1)}m</span>
            </div>
          </div>
        )}

        {renderSettings.colorMode === 'intensity' && (
          <div className="bg-[#181922]/90 backdrop-blur border border-[#2d3040] rounded-lg p-2 text-xs shadow-xl w-36">
            <div className="text-[11px] text-gray-400 font-mono mb-1">Laser Intensity</div>
            <div className="h-2.5 rounded w-full bg-gradient-to-r from-black to-white border border-gray-700" />
            <div className="flex justify-between text-[10px] text-gray-500 font-mono mt-0.5">
              <span>{metadata.intensityRange[0]}</span>
              <span>{metadata.intensityRange[1]}</span>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Center: Measurement HUD Callout */}
      {measurementHud && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-[#1b1d28]/95 backdrop-blur border border-amber-500/50 rounded-xl px-4 py-2.5 text-xs shadow-2xl flex items-center gap-5 z-20 font-mono">
          <div className="flex items-center gap-2 text-amber-400 font-bold border-r border-[#303348] pr-4">
            <Ruler className="w-4 h-4" />
            <span>3D Distance: {measurementHud.distance3D} m</span>
          </div>
          <div className="flex items-center gap-4 text-gray-300 text-[11px]">
            <div>
              <span className="text-gray-500">Horizontal: </span>
              <span className="text-gray-200">{measurementHud.distanceHorizontal} m</span>
            </div>
            <div>
              <span className="text-gray-500">ΔZ Height: </span>
              <span className={measurementHud.deltaZ >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {measurementHud.deltaZ > 0 ? `+${measurementHud.deltaZ}` : measurementHud.deltaZ} m
              </span>
            </div>
            <div>
              <span className="text-gray-500">Slope: </span>
              <span className="text-amber-300">{measurementHud.slopePercent}%</span>
            </div>
          </div>
          <button
            onClick={() => {
              setMeasurementHud(null);
              measurementPointsRef.current = [];
              if (measurementLineRef.current && sceneRef.current) {
                sceneRef.current.remove(measurementLineRef.current);
                measurementLineRef.current = null;
              }
            }}
            className="text-gray-400 hover:text-white text-[11px] underline ml-2"
          >
            Clear
          </button>
        </div>
      )}

      {/* Bottom Left: Point Cloud Telemetry Overlay */}
      <div className="absolute bottom-3 left-3 text-[11px] font-mono text-gray-400 bg-[#161820]/90 backdrop-blur px-3 py-1.5 rounded-lg border border-[#2b2e3d] pointer-events-none space-y-0.5 z-10 shadow-lg">
        <div className="flex items-center gap-2 text-gray-200 font-semibold">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>Rendered: {renderedCount.toLocaleString()} pts</span>
          <span className="text-gray-600">/</span>
          <span className="text-gray-400">{metadata.pointCount.toLocaleString()} total</span>
        </div>
        <div className="text-[10px] text-gray-500 flex items-center gap-2">
          <span>Density: {metadata.densityPerSqMeter} pts/m²</span>
          <span>·</span>
          <span>Coverage: {metadata.bounds.sizeX.toFixed(1)}m × {metadata.bounds.sizeY.toFixed(1)}m</span>
        </div>
      </div>
    </div>
  );
};
