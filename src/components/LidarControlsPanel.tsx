import React, { useState } from 'react';
import {
  LidarPoint,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  LidarColorMode,
  ColormapType,
  EditingMode
} from '../types/lidar';
import { SAMPLE_PRESETS } from '../data/sampleLidar';
import { ASPRS_CLASSIFICATIONS, getClassificationColor, getClassificationName } from '../utils/colormaps';
import {
  Layers,
  Sliders,
  Filter,
  Download,
  Upload,
  Ruler,
  Box,
  Palette,
  Scissors,
  Sparkles,
  RotateCcw,
  Check,
  Eye,
  EyeOff,
  Trash2,
  TreeDeciduous,
  Building,
  Mountain,
  HardHat,
  Info
} from 'lucide-react';

interface LidarControlsPanelProps {
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  onUpdateFilter: (filter: Partial<LidarFilterState>) => void;
  renderSettings: LidarRenderSettings;
  onUpdateRenderSettings: (settings: Partial<LidarRenderSettings>) => void;
  editingMode: EditingMode;
  onChangeEditingMode: (mode: EditingMode) => void;
  onLoadPreset: (presetId: string) => void;
  onImportFile: (file: File) => void;
  onApplyCropToPoints: () => void;
  onRemoveOutliers: () => void;
  onResetFilters: () => void;
  onExport: (format: 'las' | 'ply' | 'xyz') => void;
}

type TabKey = 'display' | 'classify' | 'crop_edit' | 'export';

export const LidarControlsPanel: React.FC<LidarControlsPanelProps> = ({
  metadata,
  filterState,
  onUpdateFilter,
  renderSettings,
  onUpdateRenderSettings,
  editingMode,
  onChangeEditingMode,
  onLoadPreset,
  onImportFile,
  onApplyCropToPoints,
  onRemoveOutliers,
  onResetFilters,
  onExport
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('classify');
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // File upload handler
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onImportFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onImportFile(e.dataTransfer.files[0]);
    }
  };

  // Toggle individual classification
  const toggleClass = (code: number) => {
    const next = new Set(filterState.enabledClasses);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    onUpdateFilter({ enabledClasses: next });
  };

  // Quick classification filters
  const isolateGroundOnly = () => {
    onUpdateFilter({ enabledClasses: new Set([2]) });
  };

  const stripGroundCanopyOnly = () => {
    const next = new Set(Object.keys(metadata.classCounts).map(Number));
    next.delete(2); // Remove ground
    onUpdateFilter({ enabledClasses: next });
  };

  const isolateBuildingsOnly = () => {
    onUpdateFilter({ enabledClasses: new Set([6]) });
  };

  const isolateVegetationOnly = () => {
    onUpdateFilter({ enabledClasses: new Set([3, 4, 5]) });
  };

  const enableAllClasses = () => {
    const all = new Set(Object.keys(metadata.classCounts).map(Number));
    onUpdateFilter({ enabledClasses: all });
  };

  return (
    <div className="flex flex-col h-full bg-[#181922] border-r border-[#2d3040] text-gray-300 overflow-hidden text-xs">
      {/* Top Header: Dataset Switcher & Import */}
      <div className="p-3 bg-[#1e202b] border-b border-[#2d3040] space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-gray-200 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
            <Mountain className="w-3.5 h-3.5 text-amber-500" />
            Active LiDAR Scan
          </span>
          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
            {metadata.format}
          </span>
        </div>

        {/* Preset Select & Upload */}
        <div className="flex items-center gap-1.5">
          <select
            value={metadata.filename}
            onChange={e => onLoadPreset(e.target.value)}
            className="flex-1 bg-[#13141c] border border-[#34384d] text-gray-200 rounded px-2 py-1.5 outline-none font-medium truncate"
          >
            {SAMPLE_PRESETS.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label
            title="Import .e57, .las, .laz, .ply, .xyz file"
            className="px-2.5 py-1.5 bg-[#2a2d3d] hover:bg-[#383d54] text-gray-200 rounded border border-[#3d425a] cursor-pointer flex items-center gap-1 shrink-0 font-medium transition-colors"
          >
            <Upload className="w-3.5 h-3.5 text-amber-400" />
            <span>Import</span>
            <input
              type="file"
              accept=".e57,.las,.laz,.ply,.xyz,.pts,.csv,.txt"
              onChange={handleFileInput}
              className="hidden"
            />
          </label>
        </div>

        {/* Drag and Drop notice */}
        <div
          onDragOver={e => { e.preventDefault(); setIsDraggingOver(true); }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={handleDrop}
          className={`border border-dashed rounded p-1.5 text-center text-[10px] transition-colors ${
            isDraggingOver
              ? 'border-amber-400 bg-amber-500/10 text-amber-300'
              : 'border-[#2f3346] text-gray-500'
          }`}
        >
          Drag & drop .E57 / .LAS / .PLY / .XYZ file here
        </div>
      </div>

      {/* Tabs Header */}
      <div className="flex border-b border-[#2d3040] bg-[#1a1c26] shrink-0">
        <button
          onClick={() => setActiveTab('classify')}
          className={`flex-1 py-2 text-center text-[11px] font-medium transition-colors border-b-2 flex items-center justify-center gap-1.5 ${
            activeTab === 'classify'
              ? 'border-[#e87d0d] text-white bg-[#20222f]'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          <Filter className="w-3.5 h-3.5" />
          <span>Classify</span>
        </button>

        <button
          onClick={() => setActiveTab('crop_edit')}
          className={`flex-1 py-2 text-center text-[11px] font-medium transition-colors border-b-2 flex items-center justify-center gap-1.5 ${
            activeTab === 'crop_edit'
              ? 'border-[#e87d0d] text-white bg-[#20222f]'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          <Scissors className="w-3.5 h-3.5" />
          <span>Crop & Edit</span>
        </button>

        <button
          onClick={() => setActiveTab('display')}
          className={`flex-1 py-2 text-center text-[11px] font-medium transition-colors border-b-2 flex items-center justify-center gap-1.5 ${
            activeTab === 'display'
              ? 'border-[#e87d0d] text-white bg-[#20222f]'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          <Palette className="w-3.5 h-3.5" />
          <span>Shading</span>
        </button>

        <button
          onClick={() => setActiveTab('export')}
          className={`flex-1 py-2 text-center text-[11px] font-medium transition-colors border-b-2 flex items-center justify-center gap-1.5 ${
            activeTab === 'export'
              ? 'border-[#e87d0d] text-white bg-[#20222f]'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export</span>
        </button>
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* TAB 1: CLASSIFICATION FILTER */}
        {activeTab === 'classify' && (
          <div className="space-y-4">
            {/* Quick Filter Presets */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                Quick Filter Presets
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={isolateGroundOnly}
                  className="px-2 py-1.5 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded border border-[#35394f] text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Mountain className="w-3.5 h-3.5 text-[#a06e3c]" />
                  <span>Ground Only (DTM)</span>
                </button>
                <button
                  onClick={stripGroundCanopyOnly}
                  className="px-2 py-1.5 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded border border-[#35394f] text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                >
                  <TreeDeciduous className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Strip Ground (Canopy)</span>
                </button>
                <button
                  onClick={isolateBuildingsOnly}
                  className="px-2 py-1.5 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded border border-[#35394f] text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Building className="w-3.5 h-3.5 text-red-400" />
                  <span>Buildings Only</span>
                </button>
                <button
                  onClick={enableAllClasses}
                  className="px-2 py-1.5 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded border border-[#35394f] text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Check className="w-3.5 h-3.5 text-blue-400" />
                  <span>Show All Classes</span>
                </button>
              </div>
            </div>

            {/* ASPRS Classification Toggles */}
            <div className="space-y-1.5 pt-1 border-t border-[#292c3c]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  ASPRS Point Classes
                </span>
                <span className="text-[10px] text-gray-500 font-mono">
                  {filterState.enabledClasses.size} active
                </span>
              </div>

              <div className="space-y-1">
                {Object.entries(metadata.classCounts).map(([clsStr, count]) => {
                  const code = parseInt(clsStr, 10);
                  const isEnabled = filterState.enabledClasses.has(code);
                  const color = getClassificationColor(code);
                  const name = getClassificationName(code);

                  return (
                    <div
                      key={code}
                      onClick={() => toggleClass(code)}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors border ${
                        isEnabled
                          ? 'bg-[#222533] border-[#373b50] text-gray-200'
                          : 'bg-[#15161d] border-[#222430] text-gray-500 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <div
                          className="w-3 h-3 rounded-full shrink-0 border border-black/30"
                          style={{ backgroundColor: `rgb(${color.join(',')})` }}
                        />
                        <span className="truncate font-medium">{name}</span>
                        <span className="text-[10px] font-mono text-gray-500">#{code}</span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 font-mono text-[10px]">
                        <span>{count.toLocaleString()} pts</span>
                        {isEnabled ? (
                          <Eye className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <EyeOff className="w-3.5 h-3.5 text-gray-600" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: CROP & EDIT */}
        {activeTab === 'crop_edit' && (
          <div className="space-y-4">
            {/* Interaction Tools (Navigate vs Measure vs Box Crop) */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                Interactive Viewport Tool
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => onChangeEditingMode('navigate')}
                  className={`p-2 rounded text-left transition-colors font-medium flex items-center gap-2 ${
                    editingMode === 'navigate'
                      ? 'bg-[#3b82f6] text-white shadow-sm'
                      : 'bg-[#252837] text-gray-300 hover:bg-[#303448]'
                  }`}
                >
                  <Layers className="w-4 h-4" />
                  <span>Orbit & Inspect</span>
                </button>

                <button
                  onClick={() => onChangeEditingMode('measure')}
                  className={`p-2 rounded text-left transition-colors font-medium flex items-center gap-2 ${
                    editingMode === 'measure'
                      ? 'bg-[#e87d0d] text-white shadow-sm'
                      : 'bg-[#252837] text-gray-300 hover:bg-[#303448]'
                  }`}
                >
                  <Ruler className="w-4 h-4" />
                  <span>3D Measure Tool</span>
                </button>
              </div>
            </div>

            {/* Height Elevation Slice */}
            <div className="space-y-2 pt-1 border-t border-[#292c3c]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  Elevation Slicing (Z)
                </span>
                <span className="text-amber-400 font-mono text-[11px]">
                  {filterState.elevationMin.toFixed(1)}m to {filterState.elevationMax.toFixed(1)}m
                </span>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-gray-500 font-mono">
                  <span>Min: {metadata.bounds.minZ.toFixed(1)}m</span>
                  <span>Max: {metadata.bounds.maxZ.toFixed(1)}m</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-400">Min Z (m)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={filterState.elevationMin}
                      onChange={e =>
                        onUpdateFilter({ elevationMin: parseFloat(e.target.value) || metadata.bounds.minZ })
                      }
                      className="w-full bg-[#13141c] border border-[#34384d] rounded p-1 text-xs text-gray-200 font-mono outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400">Max Z (m)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={filterState.elevationMax}
                      onChange={e =>
                        onUpdateFilter({ elevationMax: parseFloat(e.target.value) || metadata.bounds.maxZ })
                      }
                      className="w-full bg-[#13141c] border border-[#34384d] rounded p-1 text-xs text-gray-200 font-mono outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Box Crop ROI Volume */}
            <div className="space-y-2 pt-1 border-t border-[#292c3c]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  Bounding Box Crop (ROI)
                </span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filterState.cropBoxEnabled}
                    onChange={e => onUpdateFilter({ cropBoxEnabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00f0ff]" />
                </label>
              </div>

              {filterState.cropBoxEnabled && (
                <div className="space-y-2 bg-[#14151e] p-2.5 rounded border border-[#2d3144]">
                  <div className="text-[10px] text-gray-400">
                    Box bounds actively clip points outside region.
                  </div>
                  <button
                    onClick={onApplyCropToPoints}
                    className="w-full py-1.5 bg-[#e87d0d] hover:bg-[#ff8f1c] text-white font-semibold rounded text-xs transition-colors flex items-center justify-center gap-1.5 shadow-md"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    <span>Permanently Crop Outside Points</span>
                  </button>
                </div>
              )}
            </div>

            {/* Point Cloud Cleaning & Processing */}
            <div className="space-y-2 pt-1 border-t border-[#292c3c]">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                Point Cloud Cleaning & Decimation
              </span>

              {/* Decimation */}
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-400">Point Decimation</span>
                  <span className="text-amber-400 font-mono">
                    {Math.round(filterState.decimationRate * 100)}%
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1 font-mono text-[10px]">
                  {[1.0, 0.5, 0.25, 0.1].map(rate => (
                    <button
                      key={rate}
                      onClick={() => onUpdateFilter({ decimationRate: rate })}
                      className={`py-1 rounded text-center transition-colors ${
                        filterState.decimationRate === rate
                          ? 'bg-[#3b82f6] text-white font-bold'
                          : 'bg-[#252837] text-gray-300 hover:bg-[#32364a]'
                      }`}
                    >
                      {rate * 100}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Statistical Outlier Filter */}
              <button
                onClick={onRemoveOutliers}
                className="w-full py-2 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded border border-[#35394f] text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Remove Noise Outliers (SOR Filter)</span>
              </button>

              {/* Reset Filters */}
              <button
                onClick={onResetFilters}
                className="w-full py-1.5 text-gray-400 hover:text-white text-[11px] flex items-center justify-center gap-1 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset All Filters & Slices</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: SHADING & DISPLAY */}
        {activeTab === 'display' && (
          <div className="space-y-4">
            {/* Color Mode */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                Color By Attribute
              </span>
              <div className="space-y-1">
                {[
                  { id: 'elevation', label: 'Elevation (Z Gradient)', desc: 'Colored by height' },
                  { id: 'intensity', label: 'Reflectance Intensity', desc: 'Laser return energy' },
                  { id: 'classification', label: 'ASPRS Classification', desc: 'Standard point classes' },
                  { id: 'rgb', label: 'True RGB Color', desc: 'Photogrammetric / Camera RGB' },
                  { id: 'returns', label: 'Return Pulse Number', desc: 'First, Intermediate, Last' }
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => onUpdateRenderSettings({ colorMode: opt.id as LidarColorMode })}
                    className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center justify-between border ${
                      renderSettings.colorMode === opt.id
                        ? 'bg-[#e87d0d]/20 border-[#e87d0d] text-white'
                        : 'bg-[#222533] border-[#313548] text-gray-300 hover:bg-[#2c3044]'
                    }`}
                  >
                    <div>
                      <div className="font-semibold">{opt.label}</div>
                      <div className="text-[10px] text-gray-400">{opt.desc}</div>
                    </div>
                    {renderSettings.colorMode === opt.id && (
                      <Check className="w-4 h-4 text-[#e87d0d]" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Colormap Selector */}
            {renderSettings.colorMode === 'elevation' && (
              <div className="space-y-1.5 pt-1 border-t border-[#292c3c]">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                  Colormap Preset
                </span>
                <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                  {(['viridis', 'turbo', 'terrain', 'rainbow', 'plasma', 'spectral'] as ColormapType[]).map(cm => (
                    <button
                      key={cm}
                      onClick={() => onUpdateRenderSettings({ colormap: cm })}
                      className={`p-2 rounded text-center uppercase transition-colors border ${
                        renderSettings.colormap === cm
                          ? 'bg-[#3b82f6] text-white border-blue-400 font-bold'
                          : 'bg-[#222533] border-[#313548] text-gray-300 hover:bg-[#2c3044]'
                      }`}
                    >
                      {cm}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Point Size */}
            <div className="space-y-1.5 pt-1 border-t border-[#292c3c]">
              <div className="flex justify-between">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  Point Size
                </span>
                <span className="text-amber-400 font-mono">{renderSettings.pointSize} px</span>
              </div>
              <input
                type="range"
                min="1"
                max="8"
                step="0.5"
                value={renderSettings.pointSize}
                onChange={e => onUpdateRenderSettings({ pointSize: parseFloat(e.target.value) })}
                className="w-full accent-[#e87d0d]"
              />
              <div className="flex items-center justify-between text-[11px] text-gray-400 pt-1">
                <span>Distance Attenuation</span>
                <input
                  type="checkbox"
                  checked={renderSettings.sizeAttenuation}
                  onChange={e => onUpdateRenderSettings({ sizeAttenuation: e.target.checked })}
                  className="rounded text-amber-500"
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: EXPORT */}
        {activeTab === 'export' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
                Export Processed LiDAR Point Cloud
              </span>
              <p className="text-[11px] text-gray-400">
                Downloads currently filtered, cropped, or cleaned points with updated coordinates and classifications.
              </p>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => onExport('las')}
                className="w-full p-3 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded-lg border border-[#35394f] text-left transition-colors flex items-center justify-between group"
              >
                <div>
                  <div className="font-bold text-white text-xs flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 text-amber-400" />
                    <span>ASPRS LAS 1.2 Binary (.las)</span>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    Full industry standard format with RGB & classifications
                  </div>
                </div>
                <span className="text-xs text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  Download →
                </span>
              </button>

              <button
                onClick={() => onExport('ply')}
                className="w-full p-3 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded-lg border border-[#35394f] text-left transition-colors flex items-center justify-between group"
              >
                <div>
                  <div className="font-bold text-white text-xs flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 text-blue-400" />
                    <span>Stanford PLY Binary (.ply)</span>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    Universal mesh & point cloud format for 3D graphics
                  </div>
                </div>
                <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  Download →
                </span>
              </button>

              <button
                onClick={() => onExport('xyz')}
                className="w-full p-3 bg-[#252837] hover:bg-[#32364a] text-gray-200 rounded-lg border border-[#35394f] text-left transition-colors flex items-center justify-between group"
              >
                <div>
                  <div className="font-bold text-white text-xs flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                    <span>ASCII XYZ / CSV (.xyz)</span>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    Plaintext coordinates: X Y Z Intensity Class RGB
                  </div>
                </div>
                <span className="text-xs text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  Download →
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Metadata Summary */}
      <div className="p-3 bg-[#161720] border-t border-[#292c3c] text-[11px] font-mono text-gray-400 space-y-1 shrink-0">
        <div className="flex justify-between">
          <span>Points:</span>
          <span className="text-gray-200">{metadata.pointCount.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Coverage:</span>
          <span className="text-gray-200">
            {metadata.bounds.sizeX.toFixed(1)} × {metadata.bounds.sizeY.toFixed(1)} m
          </span>
        </div>
        <div className="flex justify-between">
          <span>ΔZ Height Range:</span>
          <span className="text-gray-200">{metadata.bounds.sizeZ.toFixed(1)} m</span>
        </div>
      </div>
    </div>
  );
};
