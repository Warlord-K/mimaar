/**
 * LiDAR Point Cloud & Agentic Analysis Type Definitions
 * Following ASPRS LAS 1.1 - 1.4 Standard Classification Specifications
 */

export interface LidarPoint {
  x: number;
  y: number;
  z: number;
  intensity?: number;
  classification?: number;
  returnNumber?: number;
  numberOfReturns?: number;
  r?: number; // 0 - 255
  g?: number; // 0 - 255
  b?: number; // 0 - 255
}

export type LidarColorMode = 'elevation' | 'intensity' | 'classification' | 'rgb' | 'returns';
export type ColormapType = 'viridis' | 'turbo' | 'rainbow' | 'terrain' | 'plasma' | 'spectral';

export interface LidarBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface LidarClassificationInfo {
  code: number;
  name: string;
  color: string;
  count: number;
  enabled: boolean;
}

export interface LidarMetadata {
  filename: string;
  format: 'LAS' | 'LAZ' | 'PLY' | 'XYZ' | 'CSV' | 'E57' | 'SYNTHETIC';
  pointCount: number;
  bounds: LidarBounds;
  hasRGB: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
  intensityRange: [number, number];
  elevationRange: [number, number];
  densityPerSqMeter: number;
  classCounts: Record<number, number>;
}

export interface LidarFilterState {
  elevationMin: number;
  elevationMax: number;
  intensityMin: number;
  intensityMax: number;
  enabledClasses: Set<number>;
  // Bounding box crop (ROI)
  cropBoxEnabled: boolean;
  cropBoxMin: [number, number, number];
  cropBoxMax: [number, number, number];
  decimationRate: number; // 1 = 100%, 0.5 = 50%, 0.25 = 25%
}

export interface LidarRenderSettings {
  colorMode: LidarColorMode;
  colormap: ColormapType;
  pointSize: number;
  sizeAttenuation: boolean;
  edlEnabled: boolean; // Eye-Dome Lighting (ambient depth enhancement)
  edlRadius: number;
  edlStrength: number;
  invertColormap: boolean;
  backgroundColor: string;
}

export interface MeasurementPoint {
  x: number;
  y: number;
  z: number;
}

export interface MeasurementResult {
  p1: MeasurementPoint;
  p2: MeasurementPoint;
  distance3D: number;
  distanceHorizontal: number;
  deltaZ: number;
  slopePercent: number;
}

export type EditingMode = 'navigate' | 'box_crop' | 'measure' | 'select_lasso' | 'height_slice';

// -------------------------------------------------------------
// Agentic LLM Contract
// -------------------------------------------------------------
export type AgentActionType =
  | 'filter_classification'
  | 'isolate_ground'
  | 'strip_ground'
  | 'isolate_buildings'
  | 'isolate_vegetation'
  | 'crop_elevation'
  | 'crop_roi'
  | 'set_color_mode'
  | 'decimate'
  | 'remove_outliers'
  | 'reset_filters'
  | 'measure_feature'
  | 'load_dataset'
  | 'export_cloud';

export interface AgentAction {
  id: string;
  type: AgentActionType;
  label: string;
  parameters: Record<string, any>;
  explanation: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  actionsExecuted?: AgentAction[];
  suggestedPrompts?: string[];
  metrics?: Record<string, any>;
}

export interface LidarDatasetPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  pointCount: number;
  recommendedColorMode: LidarColorMode;
  recommendedColormap: ColormapType;
  tags: string[];
}
