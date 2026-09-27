/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  LidarPoint,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  EditingMode,
  AgentAction,
  MeasurementResult
} from './types/lidar';
import { generateSampleDataset, SAMPLE_PRESETS } from './data/sampleLidar';
import {
  parseLasFile,
  parsePlyFile,
  parseXyzFile,
  exportToLas,
  exportToPly,
  exportToXyz
} from './utils/lidarParser';
import { LidarViewport } from './components/LidarViewport';
import { LidarControlsPanel } from './components/LidarControlsPanel';
import { LidarAgentChat } from './components/LidarAgentChat';
import { PhotorealStudio } from './components/PhotorealStudio';
import { ViewportCaptureFn } from './types/photoreal';
import {
  Layers,
  Ruler,
  Box,
  Download,
  Upload,
  RotateCcw,
  Sparkles,
  Mountain,
  Compass,
  Sliders,
  ChevronDown,
  Info,
  Check
} from 'lucide-react';

export default function App() {
  // Active dataset
  const [activePresetId, setActivePresetId] = useState<string>('urban_aerial');
  const initialData = useRef(generateSampleDataset('urban_aerial'));

  // Point cloud data & metadata
  const [points, setPoints] = useState<LidarPoint[]>(initialData.current.points);
  const [metadata, setMetadata] = useState<LidarMetadata>(initialData.current.metadata);

  // Backup of raw points for undoing permanent crop/filter edits
  const originalPointsRef = useRef<LidarPoint[]>(initialData.current.points);

  // Filtering State
  const [filterState, setFilterState] = useState<LidarFilterState>({
    elevationMin: initialData.current.metadata.bounds.minZ,
    elevationMax: initialData.current.metadata.bounds.maxZ,
    intensityMin: initialData.current.metadata.intensityRange[0],
    intensityMax: initialData.current.metadata.intensityRange[1],
    enabledClasses: new Set(Object.keys(initialData.current.metadata.classCounts).map(Number)),
    cropBoxEnabled: false,
    cropBoxMin: [
      initialData.current.metadata.bounds.minX * 0.6,
      initialData.current.metadata.bounds.minY * 0.6,
      initialData.current.metadata.bounds.minZ
    ],
    cropBoxMax: [
      initialData.current.metadata.bounds.maxX * 0.6,
      initialData.current.metadata.bounds.maxY * 0.6,
      initialData.current.metadata.bounds.maxZ
    ],
    decimationRate: 1.0
  });

  // Render & Shading Settings
  const [renderSettings, setRenderSettings] = useState<LidarRenderSettings>({
    colorMode: 'classification',
    colormap: 'viridis',
    pointSize: 3.5,
    sizeAttenuation: true,
    edlEnabled: true,
    edlRadius: 1.5,
    edlStrength: 1.0,
    invertColormap: false,
    backgroundColor: '#111217'
  });

  // Active Tool Mode (navigate | measure | box_crop)
  const [editingMode, setEditingMode] = useState<EditingMode>('navigate');

  // Right pane (Copilot chat | Photoreal Studio) and the viewport capture hook used by Photoreal Studio
  const [rightPane, setRightPane] = useState<'copilot' | 'photoreal'>('copilot');
  const captureRef = useRef<ViewportCaptureFn | null>(null);
  const photorealSceneHint =
    metadata.format === 'SYNTHETIC' ? SAMPLE_PRESETS.find(p => p.id === activePresetId)?.description ?? '' : '';

  // Load Preset Dataset
  const handleLoadPreset = (presetId: string) => {
    setActivePresetId(presetId);
    const parsed = generateSampleDataset(presetId);
    setPoints(parsed.points);
    setMetadata(parsed.metadata);
    originalPointsRef.current = parsed.points;

    const presetConfig = SAMPLE_PRESETS.find(p => p.id === presetId);
    if (presetConfig) {
      setRenderSettings(prev => ({
        ...prev,
        colorMode: presetConfig.recommendedColorMode,
        colormap: presetConfig.recommendedColormap
      }));
    }

    setFilterState({
      elevationMin: parsed.metadata.bounds.minZ,
      elevationMax: parsed.metadata.bounds.maxZ,
      intensityMin: parsed.metadata.intensityRange[0],
      intensityMax: parsed.metadata.intensityRange[1],
      enabledClasses: new Set(Object.keys(parsed.metadata.classCounts).map(Number)),
      cropBoxEnabled: false,
      cropBoxMin: [
        parsed.metadata.bounds.minX * 0.6,
        parsed.metadata.bounds.minY * 0.6,
        parsed.metadata.bounds.minZ
      ],
      cropBoxMax: [
        parsed.metadata.bounds.maxX * 0.6,
        parsed.metadata.bounds.maxY * 0.6,
        parsed.metadata.bounds.maxZ
      ],
      decimationRate: 1.0
    });
  };

  // Import User File (.las, .laz, .ply, .xyz, .csv)
  const handleImportFile = async (file: File) => {
    const filename = file.name.toLowerCase();
    try {
      if (filename.endsWith('.las') || filename.endsWith('.laz')) {
        const buffer = await file.arrayBuffer();
        const parsed = parseLasFile(buffer, file.name);
        setPoints(parsed.points);
        setMetadata(parsed.metadata);
        originalPointsRef.current = parsed.points;
        resetFilterStateForNewCloud(parsed.metadata);
      } else if (filename.endsWith('.ply')) {
        const buffer = await file.arrayBuffer();
        const parsed = parsePlyFile(buffer, file.name);
        setPoints(parsed.points);
        setMetadata(parsed.metadata);
        originalPointsRef.current = parsed.points;
        resetFilterStateForNewCloud(parsed.metadata);
      } else if (filename.endsWith('.xyz') || filename.endsWith('.pts') || filename.endsWith('.csv') || filename.endsWith('.txt')) {
        const text = await file.text();
        const parsed = parseXyzFile(text, file.name);
        setPoints(parsed.points);
        setMetadata(parsed.metadata);
        originalPointsRef.current = parsed.points;
        resetFilterStateForNewCloud(parsed.metadata);
      } else {
        alert('Unsupported file format. Please upload .LAS, .LAZ, .PLY, or .XYZ point cloud files.');
      }
    } catch (err: any) {
      console.error('File import error:', err);
      alert(`Error reading LiDAR file: ${err.message || err}`);
    }
  };

  const resetFilterStateForNewCloud = (meta: LidarMetadata) => {
    setFilterState({
      elevationMin: meta.bounds.minZ,
      elevationMax: meta.bounds.maxZ,
      intensityMin: meta.intensityRange[0],
      intensityMax: meta.intensityRange[1],
      enabledClasses: new Set(Object.keys(meta.classCounts).map(Number)),
      cropBoxEnabled: false,
      cropBoxMin: [meta.bounds.minX * 0.6, meta.bounds.minY * 0.6, meta.bounds.minZ],
      cropBoxMax: [meta.bounds.maxX * 0.6, meta.bounds.maxY * 0.6, meta.bounds.maxZ],
      decimationRate: 1.0
    });
  };

  // Permanent Box Crop: trims points outside the current crop box
  const handleApplyCropToPoints = () => {
    if (!filterState.cropBoxEnabled) return;
    const [minX, minY, minZ] = filterState.cropBoxMin;
    const [maxX, maxY, maxZ] = filterState.cropBoxMax;

    const cropped = points.filter(p =>
      p.x >= minX && p.x <= maxX &&
      p.y >= minY && p.y <= maxY &&
      p.z >= minZ && p.z <= maxZ
    );

    if (cropped.length === 0) {
      alert('Cannot crop: no points inside selected bounding box.');
      return;
    }

    setPoints(cropped);
    setFilterState(prev => ({ ...prev, cropBoxEnabled: false }));
  };

  // Statistical Outlier Removal (SOR) to clean noise
  const handleRemoveOutliers = () => {
    if (points.length < 50) return;

    // Approximate SOR: calculate z-score based on distance to cloud centroid
    let sumZ = 0;
    points.forEach(p => { sumZ += p.z; });
    const meanZ = sumZ / points.length;

    let sumSqDiff = 0;
    points.forEach(p => { sumSqDiff += (p.z - meanZ) ** 2; });
    const stdDevZ = Math.sqrt(sumSqDiff / points.length);

    // Keep points within 2.8 standard deviations in Z and non-noise classes
    const cleaned = points.filter(p => {
      const isNoiseClass = p.classification === 7 || p.classification === 18;
      const isExtremeZ = Math.abs(p.z - meanZ) > stdDevZ * 2.8;
      return !isNoiseClass && !isExtremeZ;
    });

    setPoints(cleaned);
  };

  // Reset Filters & Undo Edits
  const handleResetFilters = () => {
    setPoints(originalPointsRef.current);
    resetFilterStateForNewCloud(metadata);
  };

  // Export processed cloud to file
  const handleExport = (format: 'las' | 'ply' | 'xyz') => {
    // Only export currently filtered visible points
    const {
      elevationMin, elevationMax,
      intensityMin, intensityMax,
      enabledClasses,
      cropBoxEnabled, cropBoxMin, cropBoxMax
    } = filterState;

    const visiblePoints = points.filter(p => {
      if (p.z < elevationMin || p.z > elevationMax) return false;
      const intens = p.intensity ?? 0;
      if (intens < intensityMin || intens > intensityMax) return false;
      const cls = p.classification ?? 1;
      if (enabledClasses.size > 0 && !enabledClasses.has(cls)) return false;
      if (cropBoxEnabled) {
        if (
          p.x < cropBoxMin[0] || p.x > cropBoxMax[0] ||
          p.y < cropBoxMin[1] || p.y > cropBoxMax[1] ||
          p.z < cropBoxMin[2] || p.z > cropBoxMax[2]
        ) {
          return false;
        }
      }
      return true;
    });

    let blob: Blob;
    let filename = `lidar_export_${Date.now()}.${format}`;

    if (format === 'las') {
      blob = exportToLas(visiblePoints, metadata.bounds);
    } else if (format === 'ply') {
      blob = exportToPly(visiblePoints);
    } else {
      blob = exportToXyz(visiblePoints);
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Handle LLM Agent Actions
  const handleExecuteAgentAction = (action: AgentAction) => {
    switch (action.type) {
      case 'strip_ground':
        {
          const next = new Set(Object.keys(metadata.classCounts).map(Number));
          next.delete(2); // remove ground
          setFilterState(prev => ({ ...prev, enabledClasses: next }));
        }
        break;

      case 'isolate_ground':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([2]) }));
        break;

      case 'isolate_buildings':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([6]) }));
        break;

      case 'isolate_vegetation':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([3, 4, 5]) }));
        break;

      case 'filter_classification':
        if (action.parameters?.enabledClasses) {
          setFilterState(prev => ({
            ...prev,
            enabledClasses: new Set(action.parameters.enabledClasses)
          }));
        }
        break;

      case 'crop_elevation':
        if (action.parameters) {
          setFilterState(prev => ({
            ...prev,
            elevationMin: action.parameters.minZ ?? prev.elevationMin,
            elevationMax: action.parameters.maxZ ?? prev.elevationMax
          }));
        }
        break;

      case 'crop_roi':
        if (action.parameters) {
          const p = action.parameters;
          setFilterState(prev => ({
            ...prev,
            cropBoxEnabled: true,
            cropBoxMin: [p.minX ?? prev.cropBoxMin[0], p.minY ?? prev.cropBoxMin[1], p.minZ ?? prev.cropBoxMin[2]],
            cropBoxMax: [p.maxX ?? prev.cropBoxMax[0], p.maxY ?? prev.cropBoxMax[1], p.maxZ ?? prev.cropBoxMax[2]]
          }));
        }
        break;

      case 'set_color_mode':
        if (action.parameters) {
          setRenderSettings(prev => ({
            ...prev,
            colorMode: action.parameters.mode || prev.colorMode,
            colormap: action.parameters.colormap || prev.colormap
          }));
        }
        break;

      case 'decimate':
        if (action.parameters?.rate) {
          setFilterState(prev => ({ ...prev, decimationRate: action.parameters.rate }));
        }
        break;

      case 'remove_outliers':
        handleRemoveOutliers();
        break;

      case 'reset_filters':
        handleResetFilters();
        break;

      case 'load_dataset':
        if (action.parameters?.presetId) {
          handleLoadPreset(action.parameters.presetId);
        }
        break;

      case 'export_cloud':
        handleExport((action.parameters?.format as any) || 'las');
        break;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#111217] text-gray-200 overflow-hidden font-sans select-none">
      {/* 1. TOP HEADER TOOLBAR */}
      <header className="h-12 bg-[#181922] border-b border-[#2d3040] flex items-center justify-between px-3 shrink-0 z-30">
        {/* Left: Branding & Dataset Selection */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-amber-600 to-orange-500 flex items-center justify-center shadow-md">
              <Mountain className="w-4 h-4 text-white" />
            </div>
            <div>
              <span className="font-bold text-sm text-gray-100 tracking-tight">
                LiDAR Cloud Studio
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-gray-700 mx-1" />

          {/* Quick Dataset Selector */}
          <div className="flex items-center bg-[#20222e] border border-[#303348] rounded-md px-2 py-1 gap-2 text-xs font-mono">
            <span className="text-gray-400">Scan:</span>
            <select
              value={activePresetId}
              onChange={e => handleLoadPreset(e.target.value)}
              className="bg-transparent text-amber-400 font-semibold outline-none cursor-pointer"
            >
              {SAMPLE_PRESETS.map(p => (
                <option key={p.id} value={p.id} className="bg-[#181922] text-gray-200">
                  {p.name} ({p.pointCount.toLocaleString()} pts)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Center: Primary Interaction Tools */}
        <div className="flex items-center bg-[#20222e] border border-[#303348] rounded-lg p-0.5 text-xs font-medium">
          <button
            onClick={() => setEditingMode('navigate')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded transition-colors ${
              editingMode === 'navigate'
                ? 'bg-[#3b82f6] text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Navigate</span>
          </button>

          <button
            onClick={() => setEditingMode('measure')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded transition-colors ${
              editingMode === 'measure'
                ? 'bg-[#e87d0d] text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Ruler className="w-3.5 h-3.5" />
            <span>3D Measure</span>
          </button>

          <button
            onClick={() => {
              setFilterState(prev => ({ ...prev, cropBoxEnabled: !prev.cropBoxEnabled }));
            }}
            className={`flex items-center gap-1.5 px-3 py-1 rounded transition-colors ${
              filterState.cropBoxEnabled
                ? 'bg-[#00f0ff] text-gray-950 font-bold shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            <span>ROI Box Crop</span>
          </button>
        </div>

        {/* Right: Actions (Reset, Export) */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRightPane('photoreal')}
            title="Turn the current view into a photorealistic photo and video"
            className={`flex items-center gap-1 px-2.5 py-1.5 border rounded-lg text-xs font-medium transition-colors ${
              rightPane === 'photoreal'
                ? 'bg-[#e87d0d]/15 border-[#e87d0d]/50 text-[#ffb366]'
                : 'bg-[#252838] hover:bg-[#31354a] border-[#373b52] text-gray-300'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Photoreal</span>
          </button>

          <button
            onClick={handleResetFilters}
            title="Reset all filters and restore full cloud"
            className="flex items-center gap-1 px-2.5 py-1.5 bg-[#252838] hover:bg-[#31354a] border border-[#373b52] text-gray-300 rounded-lg text-xs font-medium transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>

          <button
            onClick={() => handleExport('las')}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[#e87d0d] hover:bg-[#ff8f1c] text-white rounded-lg text-xs font-semibold transition-all shadow-md"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export LAS</span>
          </button>
        </div>
      </header>

      {/* 2. THREE-PANE WORKSPACE */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Pane: Controls, Filters & Slicing (280px) */}
        <aside className="w-72 shrink-0 h-full overflow-hidden">
          <LidarControlsPanel
            metadata={metadata}
            filterState={filterState}
            onUpdateFilter={up => setFilterState(prev => ({ ...prev, ...up }))}
            renderSettings={renderSettings}
            onUpdateRenderSettings={up => setRenderSettings(prev => ({ ...prev, ...up }))}
            editingMode={editingMode}
            onChangeEditingMode={setEditingMode}
            onLoadPreset={handleLoadPreset}
            onImportFile={handleImportFile}
            onApplyCropToPoints={handleApplyCropToPoints}
            onRemoveOutliers={handleRemoveOutliers}
            onResetFilters={handleResetFilters}
            onExport={handleExport}
          />
        </aside>

        {/* Center Pane: 3D Point Cloud Viewport (flex-1) */}
        <main className="flex-1 h-full relative overflow-hidden">
          <LidarViewport
            points={points}
            metadata={metadata}
            filterState={filterState}
            renderSettings={renderSettings}
            editingMode={editingMode}
            captureRef={captureRef}
          />
        </main>

        {/* Right Pane: LLM Agentic Chat | Photoreal Studio (384px); both stay mounted to keep their state */}
        <aside className="w-96 shrink-0 h-full overflow-hidden flex flex-col">
          <div className="flex shrink-0 bg-[#1a1c26] border-l border-b border-[#2d3040] p-1 gap-1 text-xs font-medium">
            {(['copilot', 'photoreal'] as const).map(pane => (
              <button
                key={pane}
                onClick={() => setRightPane(pane)}
                className={`flex-1 py-1 rounded transition-colors ${
                  rightPane === pane ? 'bg-[#2c2f42] text-gray-100' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {pane === 'copilot' ? 'Copilot' : 'Photoreal'}
              </button>
            ))}
          </div>
          <div className={`flex-1 min-h-0 ${rightPane === 'copilot' ? '' : 'hidden'}`}>
            <LidarAgentChat
              metadata={metadata}
              filterState={filterState}
              renderSettings={renderSettings}
              onExecuteAgentAction={handleExecuteAgentAction}
              onResetFilters={handleResetFilters}
            />
          </div>
          <div className={`flex-1 min-h-0 ${rightPane === 'photoreal' ? '' : 'hidden'}`}>
            <PhotorealStudio
              captureRef={captureRef}
              metadata={metadata}
              filterState={filterState}
              renderSettings={renderSettings}
              defaultScene={photorealSceneHint}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
