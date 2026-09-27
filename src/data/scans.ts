/**
 * Real captured scans shipped with the app, as opposed to the synthetic presets in sampleLidar.ts.
 *
 * Each .ply in public/scans is produced from a textured mesh by tools/glb_to_pointcloud.py, which
 * samples points across the surfaces and colors them from the texture.
 */
import { ColormapType, LidarColorMode } from '../types/lidar';

export interface ScanDataset {
  id: string;
  name: string;
  url: string;
  /** Doubles as the scene hint handed to Photoreal Studio. */
  description: string;
  recommendedColorMode: LidarColorMode;
  recommendedColormap: ColormapType;
  /** World-space point size; scans are room-sized, so far smaller than the synthetic city presets. */
  pointSize: number;
  /** Put the camera inside, at eye height in the middle of the room, instead of orbiting from outside. */
  startInside: boolean;
  /** Walls and ceiling (class 6) opacity, so the room can be seen through. */
  structureOpacity: number;
}

export const SCAN_DATASETS: ScanDataset[] = [
  {
    id: 'office_28_09_2026',
    name: 'Office Scan · 28 Sep',
    url: '/scans/28_09_2026.ply',
    description: 'the interior of an office room, with desks, chairs, monitors, walls and a ceiling',
    recommendedColorMode: 'rgb',
    recommendedColormap: 'viridis',
    pointSize: 0.018,
    startInside: true,
    structureOpacity: 0.25
  }
];

export const DEFAULT_SCAN_ID = 'office_28_09_2026';

export const findScan = (id: string) => SCAN_DATASETS.find(s => s.id === id);
