/**
 * E57 -> streaming level-of-detail octree for the browser viewer.
 */

import { E57Reader, E57ScanInfo } from './reader';
import { buildOctree, OctreeSummary, PointSource } from '../pointcloud/octree';

export interface ConversionSummary extends OctreeSummary {
  e57Version: string;
  scans: E57ScanInfo[];
  sourcePoints: number;
}

export function e57Source(file: string): PointSource {
  const reader = new E57Reader(file);
  return {
    totalPoints: reader.header.totalPoints,
    hasColor: reader.header.scans.some(s => s.hasColor),
    hasIntensity: reader.header.scans.some(s => s.hasIntensity),
    readPoints: (onBatch, onProgress) => reader.readPoints(onBatch, onProgress),
    close: () => reader.close()
  };
}

export async function convertE57ToOctree(
  srcPath: string,
  outDir: string,
  onProgress?: (fraction: number, phase: string) => void
): Promise<ConversionSummary> {
  const probe = new E57Reader(srcPath);
  const { version, scans, totalPoints } = probe.header;
  probe.close();
  if (totalPoints === 0) throw new Error('E57 file contains no points');
  const octree = await buildOctree(() => e57Source(srcPath), outDir, onProgress);
  return { ...octree, e57Version: version, scans, sourcePoints: totalPoints };
}
