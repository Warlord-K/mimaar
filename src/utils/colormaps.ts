/**
 * High-performance Colormaps for LiDAR Scientific Visualization
 * Viridis, Turbo, Rainbow, Terrain (USGS Elevation), Plasma
 * ASPRS Standard Classification definitions
 */

import { ColormapType } from '../types/lidar';

// ASPRS Standard LAS Classification Codes & Standard Color Scheme
export const ASPRS_CLASSIFICATIONS: Record<number, { name: string; color: [number, number, number]; hex: string }> = {
  0: { name: 'Never Classified', color: [140, 140, 140], hex: '#8c8c8c' },
  1: { name: 'Unassigned / Default', color: [160, 160, 160], hex: '#a0a0a0' },
  2: { name: 'Ground', color: [160, 110, 60], hex: '#a06e3c' },
  3: { name: 'Low Vegetation', color: [144, 214, 115], hex: '#90d673' },
  4: { name: 'Medium Vegetation', color: [56, 173, 71], hex: '#38ad47' },
  5: { name: 'High Vegetation / Canopy', color: [18, 102, 34], hex: '#126622' },
  6: { name: 'Building / Structure', color: [235, 94, 85], hex: '#eb5e55' },
  7: { name: 'Low Point / Noise', color: [220, 20, 60], hex: '#dc143c' },
  8: { name: 'Model Key-point', color: [255, 215, 0], hex: '#ffd700' },
  9: { name: 'Water', color: [30, 144, 255], hex: '#1e90ff' },
  10: { name: 'Rail / Track', color: [178, 34, 34], hex: '#b22222' },
  11: { name: 'Road Surface', color: [65, 65, 70], hex: '#414146' },
  12: { name: 'Overlap / Wire Guard', color: [255, 140, 0], hex: '#ff8c00' },
  13: { name: 'Wire - Conductor', color: [255, 220, 0], hex: '#ffdc00' },
  14: { name: 'Transmission Tower', color: [100, 149, 237], hex: '#6495ed' },
  15: { name: 'Wire - Structure Connector', color: [186, 85, 211], hex: '#ba55d3' },
  17: { name: 'Bridge Deck', color: [190, 160, 120], hex: '#bea078' },
  18: { name: 'High Noise', color: [255, 0, 255], hex: '#ff00ff' }
};

export function getClassificationColor(code: number): [number, number, number] {
  const item = ASPRS_CLASSIFICATIONS[code];
  if (item) return item.color;
  return [150, 150, 150];
}

export function getClassificationHex(code: number): string {
  const item = ASPRS_CLASSIFICATIONS[code];
  return item ? item.hex : '#999999';
}

export function getClassificationName(code: number): string {
  const item = ASPRS_CLASSIFICATIONS[code];
  return item ? item.name : `Class ${code}`;
}

// Colormap interpolators (0.0 <= t <= 1.0) -> [R, G, B] in range [0, 1]
export function sampleColormap(t: number, type: ColormapType, invert = false): [number, number, number] {
  let val = Math.max(0, Math.min(1, t));
  if (invert) val = 1 - val;

  switch (type) {
    case 'viridis':
      return viridis(val);
    case 'turbo':
      return turbo(val);
    case 'rainbow':
      return rainbow(val);
    case 'terrain':
      return terrain(val);
    case 'plasma':
      return plasma(val);
    case 'spectral':
    default:
      return spectral(val);
  }
}

// Viridis polynomial approximation
function viridis(t: number): [number, number, number] {
  const c0 = [0.2777273272234177, 0.005407344544966578, 0.3340998053353061];
  const c1 = [0.10505055991494601, 1.4046135298991075, 1.3845964965595831];
  const c2 = [-0.3308618287255563, 0.2148782620816769, 0.09509516302823659];
  const c3 = [-4.634230498983486, -5.72910497054819, -5.770894548649844];
  const c4 = [6.228269936347081, 7.842718356193796, 7.828620807869689];
  const c5 = [-2.607425890884617, -3.731776997099723, -3.647318042407559];

  const r = c0[0] + t * (c1[0] + t * (c2[0] + t * (c3[0] + t * (c4[0] + t * c5[0]))));
  const g = c0[1] + t * (c1[1] + t * (c2[1] + t * (c3[1] + t * (c4[1] + t * c5[1]))));
  const b = c0[2] + t * (c1[2] + t * (c2[2] + t * (c3[2] + t * (c4[2] + t * c5[2]))));
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

// Google Turbo colormap (fast smooth rainbow replacement)
function turbo(t: number): [number, number, number] {
  const kRedVec4 = [0.13572138, 4.6153926, -42.66032258, 132.13108234];
  const kGreenVec4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333];
  const kBlueVec4 = [0.1066733, 12.64194608, -60.58204836, 110.36276771];
  const kRedVec2 = [-152.94239396, 59.28637943];
  const kGreenVec2 = [4.27729857, 2.82956604];
  const kBlueVec2 = [-89.90310912, 27.34824973];

  const v4 = [1.0, t, t * t, t * t * t];
  const v2 = [v4[2] * v4[2], v4[3] * v4[2]];

  const r = kRedVec4[0] * v4[0] + kRedVec4[1] * v4[1] + kRedVec4[2] * v4[2] + kRedVec4[3] * v4[3] + kRedVec2[0] * v2[0] + kRedVec2[1] * v2[1];
  const g = kGreenVec4[0] * v4[0] + kGreenVec4[1] * v4[1] + kGreenVec4[2] * v4[2] + kGreenVec4[3] * v4[3] + kGreenVec2[0] * v2[0] + kGreenVec2[1] * v2[1];
  const b = kBlueVec4[0] * v4[0] + kBlueVec4[1] * v4[1] + kBlueVec4[2] * v4[2] + kBlueVec4[3] * v4[3] + kBlueVec2[0] * v2[0] + kBlueVec2[1] * v2[1];

  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

// Scientific Terrain Elevation Colormap (Blue/Deep Green -> Lush Green -> Ochre/Sand -> Mountain Brown -> Snow White)
function terrain(t: number): [number, number, number] {
  if (t < 0.15) {
    // Low valley / wetland green
    const s = t / 0.15;
    return [0.15 + s * 0.1, 0.45 + s * 0.25, 0.25 + s * 0.05];
  } else if (t < 0.4) {
    // Lowland forest
    const s = (t - 0.15) / 0.25;
    return [0.25 + s * 0.35, 0.70 - s * 0.05, 0.30 - s * 0.15];
  } else if (t < 0.7) {
    // Plateau & Foothill ochre / brown
    const s = (t - 0.4) / 0.3;
    return [0.60 + s * 0.15, 0.65 - s * 0.25, 0.15 + s * 0.10];
  } else if (t < 0.88) {
    // Mountain rock
    const s = (t - 0.7) / 0.18;
    return [0.75 + s * 0.1, 0.40 + s * 0.35, 0.25 + s * 0.45];
  } else {
    // Alpine snow
    const s = (t - 0.88) / 0.12;
    return [0.85 + s * 0.15, 0.75 + s * 0.25, 0.70 + s * 0.30];
  }
}

// Classical Rainbow
function rainbow(t: number): [number, number, number] {
  // Hue 270 (purple) to 0 (red)
  const h = (1.0 - t) * 0.75; // 0.75 (blue/violet) down to 0.0 (red)
  return hslToRgb(h, 0.95, 0.5);
}

// Plasma
function plasma(t: number): [number, number, number] {
  const r = Math.sin(t * Math.PI * 0.7 + 0.1) * 0.5 + 0.5;
  const g = Math.sin(t * Math.PI * 1.2 - 0.8) * 0.4 + 0.4;
  const b = Math.cos(t * Math.PI * 0.9) * 0.5 + 0.5;
  return [Math.max(0, Math.min(1, r * 1.1)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

// Spectral
function spectral(t: number): [number, number, number] {
  const h = (1.0 - t) * 0.65;
  return hslToRgb(h, 0.85, 0.48);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  return [r, g, b];
}

function hueToRgb(p: number, q: number, t: number): number {
  let v = t;
  if (v < 0) v += 1;
  if (v > 1) v -= 1;
  if (v < 1 / 6) return p + (q - p) * 6 * v;
  if (v < 1 / 2) return q;
  if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
  return p;
}
