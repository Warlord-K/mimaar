/**
 * Realistic Synthetic & Surveyed LiDAR Datasets
 * Generating genuine ASPRS standard point clouds with multi-returns, intensity, and RGB
 */

import { LidarPoint, LidarMetadata, LidarDatasetPreset } from '../types/lidar';
import { ParseResult } from '../utils/lidarParser';

export const SAMPLE_PRESETS: LidarDatasetPreset[] = [
  {
    id: 'urban_aerial',
    name: 'Urban Aerial & Infrastructure',
    category: 'City & Transport',
    description: 'Multi-class airborne LiDAR scan: commercial buildings with gabled roofs, asphalt streets, high-voltage power lines, vehicle returns, and street trees.',
    pointCount: 38500,
    recommendedColorMode: 'classification',
    recommendedColormap: 'viridis',
    tags: ['ASPRS Multi-Class', 'Buildings', 'Power Lines', 'RGB']
  },
  {
    id: 'forest_watershed',
    name: 'Forested Mountain Watershed',
    category: 'Forestry & Topography',
    description: 'High-density drone forestry survey with multi-tiered canopy (low, medium, high vegetation), digital elevation model (DEM), and natural river stream corridor.',
    pointCount: 42000,
    recommendedColorMode: 'elevation',
    recommendedColormap: 'terrain',
    tags: ['Canopy Height Model', 'River Channel', 'Ground/Veg Slicing']
  },
  {
    id: 'highway_bridge',
    name: 'Highway Overpass Bridge',
    category: 'Civil Infrastructure',
    description: 'Mobile terrestrial LiDAR scan of concrete highway interchange: deck elevation, structural support pillars, guardrails, and roadway surface markings.',
    pointCount: 34000,
    recommendedColorMode: 'intensity',
    recommendedColormap: 'turbo',
    tags: ['Bridge Clearance', 'Structural Inspection', 'Intensity Reflectance']
  },
  {
    id: 'archaeological_mound',
    name: 'Archaeological Earthworks & Ruins',
    category: 'Archaeology & Geology',
    description: 'High-precision micro-topography scan revealing ancient ditch fortifications, circular stone ramparts, and micro-relief under foliage.',
    pointCount: 31000,
    recommendedColorMode: 'elevation',
    recommendedColormap: 'plasma',
    tags: ['Micro-Topography', 'Hillshade Profile', 'Ground Filtering']
  }
];

export function generateSampleDataset(presetId: string): ParseResult {
  switch (presetId) {
    case 'forest_watershed':
      return generateForestWatershed();
    case 'highway_bridge':
      return generateHighwayBridge();
    case 'archaeological_mound':
      return generateArchaeologicalMound();
    case 'urban_aerial':
    default:
      return generateUrbanAerial();
  }
}

// -------------------------------------------------------------
// 1. Urban Aerial LiDAR
// -------------------------------------------------------------
function generateUrbanAerial(): ParseResult {
  const points: LidarPoint[] = [];
  const classCounts: Record<number, number> = {};

  // Ground grid (100m x 100m) with slight rolling terrain
  for (let x = -50; x <= 50; x += 1.2) {
    for (let y = -50; y <= 50; y += 1.2) {
      // Gentle slope
      const groundZ = Math.sin(x * 0.04) * 1.5 + Math.cos(y * 0.03) * 1.2;
      const isRoad = (Math.abs(x) < 5) || (Math.abs(y) < 5);

      if (isRoad) {
        // Road surface (Class 11)
        points.push({
          x: x + (Math.random() - 0.5) * 0.4,
          y: y + (Math.random() - 0.5) * 0.4,
          z: groundZ + (Math.random() - 0.5) * 0.05,
          intensity: Math.random() < 0.1 ? 240 : 45, // Lane stripes high reflectance
          classification: 11, // Road
          returnNumber: 1,
          numberOfReturns: 1,
          r: 60,
          g: 62,
          b: 65
        });
      } else {
        // General Ground (Class 2)
        points.push({
          x: x + (Math.random() - 0.5) * 0.4,
          y: y + (Math.random() - 0.5) * 0.4,
          z: groundZ + (Math.random() - 0.5) * 0.08,
          intensity: 85 + Math.floor(Math.random() * 30),
          classification: 2, // Ground
          returnNumber: 1,
          numberOfReturns: 1,
          r: 155,
          g: 130,
          b: 95
        });
      }
    }
  }

  // 4 Commercial & Residential Buildings (Class 6)
  const buildings = [
    { cx: -25, cy: -25, w: 22, l: 26, h: 18, roofType: 'flat' },
    { cx: 26, cy: -22, w: 20, l: 24, h: 26, roofType: 'gabled' },
    { cx: -24, cy: 26, w: 24, l: 18, h: 14, roofType: 'flat' },
    { cx: 25, cy: 25, w: 18, l: 20, h: 22, roofType: 'stepped' }
  ];

  buildings.forEach(b => {
    // Walls
    const wallRes = 1.0;
    const zRes = 1.0;
    // X-walls
    for (let x = b.cx - b.w / 2; x <= b.cx + b.w / 2; x += wallRes) {
      for (let z = 0; z <= b.h; z += zRes) {
        [b.cy - b.l / 2, b.cy + b.l / 2].forEach(y => {
          points.push({
            x: x + (Math.random() - 0.5) * 0.15,
            y: y + (Math.random() - 0.5) * 0.15,
            z: z + (Math.random() - 0.5) * 0.1,
            intensity: 120 + Math.floor(Math.random() * 40),
            classification: 6,
            returnNumber: 1,
            numberOfReturns: 1,
            r: 220,
            g: 90,
            b: 80
          });
        });
      }
    }
    // Y-walls
    for (let y = b.cy - b.l / 2; y <= b.cy + b.l / 2; y += wallRes) {
      for (let z = 0; z <= b.h; z += zRes) {
        [b.cx - b.w / 2, b.cx + b.w / 2].forEach(x => {
          points.push({
            x: x + (Math.random() - 0.5) * 0.15,
            y: y + (Math.random() - 0.5) * 0.15,
            z: z + (Math.random() - 0.5) * 0.1,
            intensity: 120 + Math.floor(Math.random() * 40),
            classification: 6,
            returnNumber: 1,
            numberOfReturns: 1,
            r: 220,
            g: 90,
            b: 80
          });
        });
      }
    }
    // Roof points (high intensity metal/tile)
    for (let x = b.cx - b.w / 2; x <= b.cx + b.w / 2; x += 0.8) {
      for (let y = b.cy - b.l / 2; y <= b.cy + b.l / 2; y += 0.8) {
        let rz = b.h;
        if (b.roofType === 'gabled') {
          rz = b.h + 4.5 - (Math.abs(x - b.cx) / (b.w / 2)) * 4.5;
        } else if (b.roofType === 'stepped' && Math.abs(x - b.cx) < b.w / 4 && Math.abs(y - b.cy) < b.l / 4) {
          rz = b.h + 3.0;
        }
        points.push({
          x: x + (Math.random() - 0.5) * 0.1,
          y: y + (Math.random() - 0.5) * 0.1,
          z: rz + (Math.random() - 0.5) * 0.1,
          intensity: 190 + Math.floor(Math.random() * 50),
          classification: 6,
          returnNumber: 1,
          numberOfReturns: 1,
          r: 235,
          g: 105,
          b: 95
        });
      }
    }
  });

  // Street Trees (Class 3 Low, Class 4 Medium, Class 5 High Veg with Multi-Returns)
  const treeLocations = [
    { x: -8, y: -15 }, { x: -8, y: 0 }, { x: -8, y: 15 }, { x: -8, y: 35 },
    { x: 8, y: -35 }, { x: 8, y: -15 }, { x: 8, y: 10 }, { x: 8, y: 30 },
    { x: -38, y: -6 }, { x: 38, y: -6 }, { x: -6, y: -38 }, { x: 6, y: -38 }
  ];

  treeLocations.forEach(tl => {
    const treeHeight = 7 + Math.random() * 5;
    const crownRadius = 2.5 + Math.random() * 1.5;

    // Canopy points (500 pts per tree)
    for (let p = 0; p < 450; p++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = Math.cbrt(Math.random()) * crownRadius;

      const px = tl.x + r * Math.sin(phi) * Math.cos(theta);
      const py = tl.y + r * Math.sin(phi) * Math.sin(theta);
      const pz = (treeHeight * 0.65) + r * Math.cos(phi);

      if (pz > 0.5) {
        let cls = 5; // High veg
        if (pz < 2.0) cls = 3; // Low veg
        else if (pz < 5.0) cls = 4; // Med veg

        const retNum = pz > treeHeight * 0.7 ? 1 : Math.random() < 0.6 ? 2 : 3;

        points.push({
          x: px,
          y: py,
          z: pz,
          intensity: 60 + Math.floor(Math.random() * 55),
          classification: cls,
          returnNumber: retNum,
          numberOfReturns: 3,
          r: 34 + Math.floor(Math.random() * 30),
          g: 139 + Math.floor(Math.random() * 50),
          b: 34 + Math.floor(Math.random() * 30)
        });
      }
    }

    // Trunk
    for (let tz = 0; tz < treeHeight * 0.6; tz += 0.4) {
      points.push({
        x: tl.x + (Math.random() - 0.5) * 0.3,
        y: tl.y + (Math.random() - 0.5) * 0.3,
        z: tz,
        intensity: 80,
        classification: 4,
        returnNumber: 2,
        numberOfReturns: 2,
        r: 100,
        g: 75,
        b: 50
      });
    }
  });

  // Power Line Conductors (Class 13) & Transmission Poles (Class 14)
  const wireX = -12;
  const wireZBase = 12;
  for (let y = -48; y <= 48; y += 0.5) {
    // Sag catenary curve
    const sag1 = Math.sin((y + 48) / 96 * Math.PI * 2) * 1.5;
    points.push({
      x: wireX,
      y: y,
      z: wireZBase - sag1,
      intensity: 220,
      classification: 13, // Wire
      returnNumber: 1,
      numberOfReturns: 1,
      r: 255,
      g: 220,
      b: 0
    });
    points.push({
      x: wireX + 2.5,
      y: y,
      z: wireZBase + 0.5 - sag1,
      intensity: 215,
      classification: 13,
      returnNumber: 1,
      numberOfReturns: 1,
      r: 255,
      g: 220,
      b: 0
    });
  }

  // Poles
  [-30, 0, 30].forEach(py => {
    for (let pz = 0; pz <= wireZBase + 1.5; pz += 0.4) {
      points.push({
        x: wireX + 1.25 + (Math.random() - 0.5) * 0.2,
        y: py + (Math.random() - 0.5) * 0.2,
        z: pz,
        intensity: 175,
        classification: 14, // Transmission Tower
        returnNumber: 1,
        numberOfReturns: 1,
        r: 100,
        g: 149,
        b: 237
      });
    }
  });

  return finalizeDataset(points, 'urban_aerial_survey.las', 'LAS');
}

// -------------------------------------------------------------
// 2. Forest Watershed & River Topography
// -------------------------------------------------------------
function generateForestWatershed(): ParseResult {
  const points: LidarPoint[] = [];

  // Valley & River Bed Topography
  for (let x = -40; x <= 40; x += 1.1) {
    for (let y = -40; y <= 40; y += 1.1) {
      // Meandering river corridor at x ~ sin(y*0.08)*12
      const riverCenter = Math.sin(y * 0.08) * 12;
      const distFromRiver = Math.abs(x - riverCenter);

      // Deep valley elevation
      const valleyZ = (distFromRiver * distFromRiver) * 0.018 + (Math.sin(x * 0.06) + Math.cos(y * 0.05)) * 4.0;

      if (distFromRiver < 4.0) {
        // Water channel (Class 9)
        points.push({
          x: x + (Math.random() - 0.5) * 0.3,
          y: y + (Math.random() - 0.5) * 0.3,
          z: 0.2 + (Math.random() - 0.5) * 0.05,
          intensity: 15, // Water absorbs infrared laser pulse -> very low intensity
          classification: 9,
          returnNumber: 1,
          numberOfReturns: 1,
          r: 30,
          g: 144,
          b: 255
        });
      } else {
        // Bare Ground DEM (Class 2)
        points.push({
          x: x + (Math.random() - 0.5) * 0.3,
          y: y + (Math.random() - 0.5) * 0.3,
          z: valleyZ,
          intensity: 90 + Math.floor(Math.random() * 40),
          classification: 2,
          returnNumber: 3, // Last return
          numberOfReturns: 3,
          r: 130,
          g: 95,
          b: 55
        });

        // Dense foliage vegetation on slopes
        if (Math.random() < 0.45) {
          const canopyHeight = 8 + Math.random() * 12;
          for (let k = 0; k < 6; k++) {
            const h = valleyZ + (0.3 + Math.random() * 0.7) * canopyHeight;
            let cls = 5;
            if (h - valleyZ < 2.5) cls = 3;
            else if (h - valleyZ < 6.0) cls = 4;

            points.push({
              x: x + (Math.random() - 0.5) * 1.5,
              y: y + (Math.random() - 0.5) * 1.5,
              z: h,
              intensity: 70 + Math.floor(Math.random() * 40),
              classification: cls,
              returnNumber: k === 5 ? 1 : 2,
              numberOfReturns: 3,
              r: 25 + Math.floor(Math.random() * 30),
              g: 110 + Math.floor(Math.random() * 50),
              b: 30 + Math.floor(Math.random() * 25)
            });
          }
        }
      }
    }
  }

  return finalizeDataset(points, 'forest_watershed_dem.las', 'LAS');
}

// -------------------------------------------------------------
// 3. Highway Bridge Infrastructure
// -------------------------------------------------------------
function generateHighwayBridge(): ParseResult {
  const points: LidarPoint[] = [];

  // Ground / River under the bridge
  for (let x = -40; x <= 40; x += 1.2) {
    for (let y = -25; y <= 25; y += 1.2) {
      points.push({
        x, y,
        z: -6 + Math.sin(x * 0.1) * 0.8,
        intensity: 75,
        classification: 2,
        returnNumber: 1,
        numberOfReturns: 1,
        r: 100, g: 90, b: 80
      });
    }
  }

  // Elevated Bridge Deck (Class 17) spanning across X from -35 to 35, Y from -6 to 6, Z = 6m
  for (let x = -35; x <= 35; x += 0.6) {
    for (let y = -7; y <= 7; y += 0.6) {
      // Bridge Deck surface
      points.push({
        x: x + (Math.random() - 0.5) * 0.1,
        y: y + (Math.random() - 0.5) * 0.1,
        z: 6.0 + (Math.random() - 0.5) * 0.05,
        intensity: Math.abs(y) === 0 || Math.abs(y) === 3.5 ? 245 : 60, // lane markings
        classification: 17, // Bridge Deck
        returnNumber: 1,
        numberOfReturns: 1,
        r: 185, g: 175, b: 165
      });
    }

    // Concrete Guardrails on edges
    [-7.2, 7.2].forEach(gy => {
      for (let gz = 6.0; gz <= 7.2; gz += 0.3) {
        points.push({
          x: x + (Math.random() - 0.5) * 0.05,
          y: gy + (Math.random() - 0.5) * 0.05,
          z: gz,
          intensity: 180,
          classification: 17,
          returnNumber: 1,
          numberOfReturns: 1,
          r: 210, g: 200, b: 190
        });
      }
    });
  }

  // Concrete Bridge Support Piers (Pillars)
  [-20, 0, 20].forEach(px => {
    [-4, 4].forEach(py => {
      for (let pz = -6.0; pz <= 6.0; pz += 0.35) {
        for (let a = 0; a < Math.PI * 2; a += 0.5) {
          points.push({
            x: px + Math.cos(a) * 1.2,
            y: py + Math.sin(a) * 1.2,
            z: pz,
            intensity: 140,
            classification: 17,
            returnNumber: 1,
            numberOfReturns: 1,
            r: 160, g: 155, b: 150
          });
        }
      }
    });
  });

  return finalizeDataset(points, 'highway_bridge_scan.las', 'LAS');
}

// -------------------------------------------------------------
// 4. Archaeological Mound & Earthworks
// -------------------------------------------------------------
function generateArchaeologicalMound(): ParseResult {
  const points: LidarPoint[] = [];

  for (let x = -35; x <= 35; x += 0.9) {
    for (let y = -35; y <= 35; y += 0.9) {
      const r = Math.sqrt(x * x + y * y);

      // Central mound + surrounding ditch + outer rampart bank
      let z = 0;
      let cls = 2; // Ground

      if (r < 12) {
        // Inner citadel mound
        z = 6.0 * (1 - (r / 12) * (r / 12));
      } else if (r >= 12 && r < 18) {
        // Defensive Ditch depression
        z = -2.5 * Math.sin(((r - 12) / 6) * Math.PI);
      } else if (r >= 18 && r < 24) {
        // Outer defensive bank rampart
        z = 2.8 * Math.sin(((r - 18) / 6) * Math.PI);
      } else {
        z = Math.sin(x * 0.08) * 0.8 + Math.cos(y * 0.06) * 0.7;
      }

      // Add stone foundation ruins on top
      if (r < 8 && Math.abs(x) < 4 && Math.abs(y) < 4 && (Math.abs(x) > 3.2 || Math.abs(y) > 3.2)) {
        z += 1.2;
        cls = 6; // Stone structure
      }

      points.push({
        x: x + (Math.random() - 0.5) * 0.2,
        y: y + (Math.random() - 0.5) * 0.2,
        z: z + (Math.random() - 0.5) * 0.1,
        intensity: cls === 6 ? 210 : 85 + Math.floor(Math.random() * 30),
        classification: cls,
        returnNumber: 1,
        numberOfReturns: 1,
        r: cls === 6 ? 220 : 140,
        g: cls === 6 ? 180 : 160,
        b: cls === 6 ? 150 : 110
      });
    }
  }

  return finalizeDataset(points, 'archaeology_hillfort.las', 'LAS');
}

// Helper to compute metadata and class counts
function finalizeDataset(points: LidarPoint[], filename: string, format: any): ParseResult {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let minIntensity = Infinity, maxIntensity = -Infinity;
  const classCounts: Record<number, number> = {};

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;

    const intens = p.intensity ?? 0;
    if (intens < minIntensity) minIntensity = intens;
    if (intens > maxIntensity) maxIntensity = intens;

    const cls = p.classification ?? 1;
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  }

  const bounds = {
    minX, maxX, minY, maxY, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: Math.abs(maxX - minX),
    sizeY: Math.abs(maxY - minY),
    sizeZ: Math.abs(maxZ - minZ)
  };

  const area = Math.max(1, bounds.sizeX * bounds.sizeY);
  const density = points.length / area;

  const metadata: LidarMetadata = {
    filename,
    format,
    pointCount: points.length,
    bounds,
    hasRGB: true,
    hasIntensity: true,
    hasClassification: true,
    intensityRange: [minIntensity, maxIntensity],
    elevationRange: [minZ, maxZ],
    densityPerSqMeter: Number(density.toFixed(2)),
    classCounts
  };

  return { points, metadata };
}
