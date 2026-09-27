import React, { useEffect, useRef, useState } from 'react';
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
import { Focus, Move3d, Ruler, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

interface LidarViewportProps {
  points: LidarPoint[];
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  editingMode: EditingMode;
  onChangeEditingMode: (mode: EditingMode) => void;
  onUpdateCropBox?: (min: [number, number, number], max: [number, number, number]) => void;
  onMeasurementChange?: (result: MeasurementResult | null) => void;
  /** Filled with a function that captures the current view (used by Photoreal Studio). */
  captureRef?: React.MutableRefObject<ViewportCaptureFn | null>;
  /** Start at eye height in the middle of the cloud (room scans) rather than orbiting from outside. */
  startInside?: boolean;
}

export const LidarViewport: React.FC<LidarViewportProps> = ({
  points,
  metadata,
  filterState,
  renderSettings,
  editingMode,
  onChangeEditingMode,
  onUpdateCropBox,
  onMeasurementChange,
  captureRef,
  startInside = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const pointsMeshRef = useRef<THREE.Points | null>(null);
  /** Structure points drawn translucent on top of the opaque cloud when structureOpacity < 1. */
  const translucentMeshRef = useRef<THREE.Points | null>(null);
  const cropBoxMeshRef = useRef<THREE.LineSegments | null>(null);
  const measurementLineRef = useRef<THREE.Line | null>(null);

  // Visible point count state for HUD
  const [renderedCount, setRenderedCount] = useState<number>(0);
  const [measurementHud, setMeasurementHud] = useState<MeasurementResult | null>(null);
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

  const fitRadius = () => {
    const maxDim = Math.max(metadata.bounds.sizeX, metadata.bounds.sizeY, metadata.bounds.sizeZ);
    const el = containerRef.current;
    const aspect = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1;
    return Math.max(Math.min(30, maxDim * 1.5), (maxDim * 1.25) / Math.min(1, aspect));
  };

  const maxDimension = () => Math.max(metadata.bounds.sizeX, metadata.bounds.sizeY, metadata.bounds.sizeZ);

  const applyOrbit = () => {
    const { theta, phi, radius, target } = orbitRef.current;
    cameraRef.current?.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y - radius * Math.sin(phi) * Math.cos(theta),
      target.z + radius * Math.cos(phi)
    );
    cameraRef.current?.lookAt(target);
  };

  /** Eye height in the middle of the room, looking level toward the furniture rather than a bare wall. */
  const placeInside = () => {
    const b = metadata.bounds;
    const orbit = orbitRef.current;
    orbit.target.set(b.centerX, b.centerY, b.minZ + Math.min(1.5, b.sizeZ * 0.5));
    orbit.radius = 0.05; // camera sits on the target, so dragging looks around the room
    orbit.phi = Math.PI / 2;

    // Objects are everything that is neither floor (2) nor walls / ceiling (6)
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < points.length; i += 7) {
      const c = points[i].classification ?? 1;
      if (c === 2 || c === 6) continue;
      sx += points[i].x; sy += points[i].y; n++;
    }
    const dx = n ? sx / n - b.centerX : 0;
    const dy = n ? sy / n - b.centerY : 0;
    // View direction is (-sin θ, cos θ); fall back to the longer side if the objects sit dead centre
    orbit.theta = Math.hypot(dx, dy) > 0.3 ? Math.atan2(-dx, dy) : b.sizeX >= b.sizeY ? -Math.PI / 2 : 0;
  };

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
    scene.background = new THREE.Color('#0c0c0f');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    cameraRef.current = camera;

    // Ground Reference Grid
    const grid = new THREE.GridHelper(120, 24, 0x2a2a31, 0x18181c);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(metadata.bounds.centerX, metadata.bounds.centerY, metadata.bounds.minZ - 0.5);
    grid.name = 'lidar_grid';
    scene.add(grid);

    // Initial Camera Positioning centered on point cloud bounds
    const center = new THREE.Vector3(
      metadata.bounds.centerX,
      metadata.bounds.centerY,
      metadata.bounds.centerZ
    );
    orbitRef.current.target.copy(center);
    orbitRef.current.radius = fitRadius();

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
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
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
      // Photoreal needs solid walls; translucent ones read as glass
      const faded = translucentMeshRef.current?.material as THREE.PointsMaterial | undefined;
      const fadedState = faded ? { opacity: faded.opacity, depthWrite: faded.depthWrite } : null;
      if (faded) { faded.opacity = 1; faded.depthWrite = true; }
      renderer.render(scene, camera);

      const src = renderer.domElement;
      const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
      const out = document.createElement('canvas');
      out.width = Math.round(src.width * scale);
      out.height = Math.round(src.height * scale);
      out.getContext('2d')?.drawImage(src, 0, 0, out.width, out.height);

      helpers.forEach((h, i) => { h.visible = wasVisible[i]; });
      if (faded && fadedState) { faded.opacity = fadedState.opacity; faded.depthWrite = fadedState.depthWrite; }
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
      sceneRef.current.background = new THREE.Color('#0c0c0f');
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
    orbitRef.current.radius = fitRadius();
    if (startInside) placeInside();
    applyOrbit();

    // The grid was sized for city-scale clouds; shrink it to sit just under a room's floor
    const grid = sceneRef.current?.getObjectByName('lidar_grid');
    if (grid) {
      const small = maxDimension() < 30;
      grid.scale.setScalar(small ? (maxDimension() * 3) / 120 : 1);
      grid.position.set(metadata.bounds.centerX, metadata.bounds.centerY, metadata.bounds.minZ - (small ? 0.01 : 0.5));
    }
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

    const structureOpacity = renderSettings.structureOpacity ?? 1;
    const fadeStructure = structureOpacity < 0.999;
    const tPosArray = new Float32Array(fadeStructure ? maxPoints * 3 : 0);
    const tColArray = new Float32Array(fadeStructure ? maxPoints * 3 : 0);
    let tCount = 0;

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

      // Add to buffer: walls / buildings go to the translucent layer when faded
      const faded = fadeStructure && cls === 6;
      const pos = faded ? tPosArray : posArray;
      const col = faded ? tColArray : colArray;
      const k = (faded ? tCount++ : count++) * 3;
      pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
      col[k] = r; col[k + 1] = g; col[k + 2] = b;
    }

    setRenderedCount(count + tCount);

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

    for (const ref of [pointsMeshRef, translucentMeshRef]) {
      if (!ref.current) continue;
      scene.remove(ref.current);
      ref.current.geometry.dispose();
      (ref.current.material as THREE.Material).dispose();
      ref.current = null;
    }

    const pointsMesh = new THREE.Points(geometry, material);
    scene.add(pointsMesh);
    pointsMeshRef.current = pointsMesh;

    if (tCount > 0) {
      const tGeometry = new THREE.BufferGeometry();
      tGeometry.setAttribute('position', new THREE.BufferAttribute(tPosArray.subarray(0, tCount * 3), 3));
      tGeometry.setAttribute('color', new THREE.BufferAttribute(tColArray.subarray(0, tCount * 3), 3));
      const tMesh = new THREE.Points(
        tGeometry,
        new THREE.PointsMaterial({
          size: renderSettings.pointSize,
          vertexColors: true,
          sizeAttenuation: renderSettings.sizeAttenuation,
          transparent: true,
          opacity: structureOpacity,
          // Writing depth keeps it to one wall layer: without it every wall behind stacks up and turns opaque.
          // The opaque cloud is drawn first, so furniture still shows through.
          depthWrite: true
        })
      );
      tMesh.renderOrder = 1;
      scene.add(tMesh);
      translucentMeshRef.current = tMesh;
    }
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
  const handleMouseDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement) !== canvasRef.current) return;
    canvasRef.current?.setPointerCapture(e.pointerId);
    if (editingMode === 'measure' && e.button === 0) {
      // Pick 3D point for measurement
      handlePickMeasurementPoint(e);
      return;
    }

    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      isPanningRef.current = true;
    } else if (e.button === 0) {
      isDraggingRef.current = true;
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.PointerEvent) => {
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
      const panSpeed = Math.max(orbitRef.current.radius, maxDimension() * 0.3) * 0.0015;
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
    const minRadius = startInside ? 0.02 : Math.min(2.0, maxDimension() * 0.02);
    orbitRef.current.radius = Math.max(minRadius, Math.min(500, orbitRef.current.radius + zoomDelta));

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
  const handlePickMeasurementPoint = (e: React.PointerEvent) => {
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
      orbit.radius = fitRadius();
      orbit.theta = Math.PI / 4;
      orbit.phi = Math.PI / 3.2;
      if (startInside) placeInside();
    }

    if (cameraRef.current) {
      const x = orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta);
      const y = orbit.target.y - orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta);
      const z = orbit.target.z + orbit.radius * Math.cos(orbit.phi);
      cameraRef.current.position.set(x, y, z);
      cameraRef.current.lookAt(orbit.target);
    }
  };

  const clearMeasurement = () => {
    setMeasurementHud(null);
    measurementPointsRef.current = [];
    if (measurementLineRef.current && sceneRef.current) {
      sceneRef.current.remove(measurementLineRef.current);
      measurementLineRef.current = null;
    }
  };

  const legendGradient =
    renderSettings.colormap === 'viridis'
      ? 'linear-gradient(to right, #440154, #3b528b, #21908d, #5dc863, #fde725)'
      : renderSettings.colormap === 'turbo'
      ? 'linear-gradient(to right, #30123b, #4582ec, #32d667, #e1dc32, #d13008)'
      : renderSettings.colormap === 'terrain'
      ? 'linear-gradient(to right, #267340, #59b34d, #b3a626, #bfa640, #ffffff)'
      : renderSettings.colormap === 'plasma'
      ? 'linear-gradient(to right, #0d0887, #7e03a8, #cc4778, #f89540, #f0f921)'
      : 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)';

  const overlay = 'rounded-lg border bg-background/80 backdrop-blur-md shadow-sm';

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none overflow-hidden bg-[#0c0c0f] select-none outline-none"
      onPointerDown={handleMouseDown}
      onPointerMove={handleMouseMove}
      onPointerUp={handleMouseUp}
      onPointerCancel={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={e => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'block h-full w-full',
          editingMode === 'measure' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        )}
      />

      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          className={cn(overlay, 'p-0.5')}
          value={editingMode}
          onValueChange={v => v && onChangeEditingMode(v as EditingMode)}
        >
          <ToggleGroupItem value="navigate" aria-label="Orbit">
            <Move3d />
            <span className="hidden sm:inline">Orbit</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="measure" aria-label="Measure">
            <Ruler />
            <span className="hidden sm:inline">Measure</span>
          </ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          size="sm"
          className={cn(overlay, 'p-0.5')}
          value={viewPreset}
          onValueChange={v => v && setCameraPreset(v as 'top' | 'front' | 'side')}
        >
          <ToggleGroupItem value="top" className="px-2 text-xs">Top</ToggleGroupItem>
          <ToggleGroupItem value="front" className="px-2 text-xs">Front</ToggleGroupItem>
          <ToggleGroupItem value="side" className="px-2 text-xs">Side</ToggleGroupItem>
        </ToggleGroup>

        <Button
          size="icon-sm"
          variant="ghost"
          className={overlay}
          onClick={() => setCameraPreset('reset')}
          aria-label="Reset camera"
        >
          <Focus />
        </Button>
      </div>

      {renderSettings.colorMode === 'elevation' && (
        <div className={cn(overlay, 'absolute top-3 right-3 z-10 hidden w-40 p-2.5 sm:block')}>
          <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
            <span>Elevation</span>
            <span className="capitalize">{renderSettings.colormap}</span>
          </div>
          <div className="h-1.5 w-full rounded-full" style={{ background: legendGradient }} />
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums">
            <span>{metadata.bounds.minZ.toFixed(1)} m</span>
            <span>{metadata.bounds.maxZ.toFixed(1)} m</span>
          </div>
        </div>
      )}

      {editingMode === 'measure' && !measurementHud && (
        <div className={cn(overlay, 'absolute bottom-14 left-1/2 z-10 -translate-x-1/2 px-3 py-1.5 text-xs text-muted-foreground whitespace-nowrap')}>
          Tap two points to measure
        </div>
      )}

      {measurementHud && (
        <div className={cn(overlay, 'absolute bottom-14 left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 px-3 py-2 font-mono text-xs tabular-nums whitespace-nowrap')}>
          <span className="font-semibold text-primary">{measurementHud.distance3D} m</span>
          <span className="text-muted-foreground">
            ΔZ {measurementHud.deltaZ > 0 ? '+' : ''}{measurementHud.deltaZ} m
          </span>
          <span className="hidden text-muted-foreground sm:inline">slope {measurementHud.slopePercent}%</span>
          <Button size="icon-xs" variant="ghost" onClick={clearMeasurement} aria-label="Clear measurement">
            <X />
          </Button>
        </div>
      )}

      <div className={cn(overlay, 'pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 px-2.5 py-1 font-mono text-[11px] text-muted-foreground tabular-nums')}>
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="text-foreground">{renderedCount.toLocaleString()}</span>
        <span>/ {metadata.pointCount.toLocaleString()} pts</span>
        <span className="hidden sm:inline">· {metadata.bounds.sizeX.toFixed(0)} × {metadata.bounds.sizeY.toFixed(0)} m</span>
      </div>
    </div>
  );
};
