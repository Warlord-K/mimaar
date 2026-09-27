/**
 * Native High-Speed LiDAR Binary & Text Parser and Exporter
 * Supports ASPRS LAS 1.1 - 1.4, Stanford PLY, and XYZ/PTS/CSV
 */

import { LidarPoint, LidarMetadata, LidarBounds } from '../types/lidar';

export interface ParseResult {
  points: LidarPoint[];
  metadata: LidarMetadata;
}

// -------------------------------------------------------------
// 1. Binary LAS / LAZ Reader
// -------------------------------------------------------------
export function parseLasFile(buffer: ArrayBuffer, filename = 'cloud.las'): ParseResult {
  const view = new DataView(buffer);

  // Check magic signature 'LASF'
  const sig = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );

  if (sig !== 'LASF') {
    throw new Error(`Invalid LAS file signature: expected 'LASF', got '${sig}'`);
  }

  const verMajor = view.getUint8(24);
  const verMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const offsetToPoints = view.getUint32(96, true);
  const pointFormat = view.getUint8(104);
  const pointRecordLength = view.getUint16(105, true);

  // In LAS 1.4, point count can be 64-bit at offset 247
  let numPoints = view.getUint32(107, true);
  if (numPoints === 0 && verMajor >= 1 && verMinor >= 4 && buffer.byteLength >= 255) {
    // Read low 32 bits of 64-bit point count
    numPoints = view.getUint32(247, true);
  }

  // Scale and Offset factors
  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);

  const offsetX = view.getFloat64(155, true);
  const offsetY = view.getFloat64(163, true);
  const offsetZ = view.getFloat64(171, true);

  const minX = view.getFloat64(187, true);
  const maxX = view.getFloat64(179, true);
  const minY = view.getFloat64(203, true);
  const maxY = view.getFloat64(195, true);
  const minZ = view.getFloat64(219, true);
  const maxZ = view.getFloat64(211, true);

  // Safety clamp on number of points based on file size
  const maxPossiblePoints = Math.floor((buffer.byteLength - offsetToPoints) / pointRecordLength);
  const countToRead = Math.min(numPoints, maxPossiblePoints);

  const points: LidarPoint[] = new Array(countToRead);
  let minIntensity = Infinity;
  let maxIntensity = -Infinity;
  let hasRGB = pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8;
  const classCounts: Record<number, number> = {};

  let actualMinZ = Infinity;
  let actualMaxZ = -Infinity;
  let actualMinX = Infinity;
  let actualMaxX = -Infinity;
  let actualMinY = Infinity;
  let actualMaxY = -Infinity;

  let bytePtr = offsetToPoints;
  for (let i = 0; i < countToRead; i++) {
    const rawX = view.getInt32(bytePtr, true);
    const rawY = view.getInt32(bytePtr + 4, true);
    const rawZ = view.getInt32(bytePtr + 8, true);
    const intensity = view.getUint16(bytePtr + 12, true);

    const flags = view.getUint8(bytePtr + 14);
    const returnNumber = flags & 0x07;
    const numberOfReturns = (flags >> 3) & 0x07;
    const classification = view.getUint8(bytePtr + 15);

    const x = rawX * scaleX + offsetX;
    const y = rawY * scaleY + offsetY;
    const z = rawZ * scaleZ + offsetZ;

    // Track bounds
    if (x < actualMinX) actualMinX = x;
    if (x > actualMaxX) actualMaxX = x;
    if (y < actualMinY) actualMinY = y;
    if (y > actualMaxY) actualMaxY = y;
    if (z < actualMinZ) actualMinZ = z;
    if (z > actualMaxZ) actualMaxZ = z;

    if (intensity < minIntensity) minIntensity = intensity;
    if (intensity > maxIntensity) maxIntensity = intensity;

    classCounts[classification] = (classCounts[classification] || 0) + 1;

    let r: number | undefined;
    let g: number | undefined;
    let b: number | undefined;

    // In format 2 & 3, RGB colors are 16-bit uints near the end of the record
    if (hasRGB) {
      // Standard LAS format 2 & 3 RGB starts at offset 20 or 28
      const rgbOffset = pointFormat === 2 ? 20 : pointFormat === 3 ? 28 : 28;
      if (rgbOffset + 6 <= pointRecordLength) {
        const rawR = view.getUint16(bytePtr + rgbOffset, true);
        const rawG = view.getUint16(bytePtr + rgbOffset + 2, true);
        const rawB = view.getUint16(bytePtr + rgbOffset + 4, true);
        // Normalize 16-bit (0-65535) or 8-bit to 0-255
        r = rawR > 255 ? Math.floor(rawR / 256) : rawR;
        g = rawG > 255 ? Math.floor(rawG / 256) : rawG;
        b = rawB > 255 ? Math.floor(rawB / 256) : rawB;
      }
    }

    points[i] = {
      x,
      y,
      z,
      intensity,
      classification,
      returnNumber,
      numberOfReturns,
      r,
      g,
      b
    };

    bytePtr += pointRecordLength;
  }

  const bounds: LidarBounds = {
    minX: actualMinX !== Infinity ? actualMinX : minX,
    maxX: actualMaxX !== -Infinity ? actualMaxX : maxX,
    minY: actualMinY !== Infinity ? actualMinY : minY,
    maxY: actualMaxY !== -Infinity ? actualMaxY : maxY,
    minZ: actualMinZ !== Infinity ? actualMinZ : minZ,
    maxZ: actualMaxZ !== -Infinity ? actualMaxZ : maxZ,
    centerX: (actualMinX + actualMaxX) / 2,
    centerY: (actualMinY + actualMaxY) / 2,
    centerZ: (actualMinZ + actualMaxZ) / 2,
    sizeX: Math.abs(actualMaxX - actualMinX),
    sizeY: Math.abs(actualMaxY - actualMinY),
    sizeZ: Math.abs(actualMaxZ - actualMinZ)
  };

  const area = Math.max(1, bounds.sizeX * bounds.sizeY);
  const density = countToRead / area;

  const metadata: LidarMetadata = {
    filename,
    format: 'LAS',
    pointCount: countToRead,
    bounds,
    hasRGB: !!hasRGB,
    hasIntensity: true,
    hasClassification: true,
    intensityRange: [minIntensity === Infinity ? 0 : minIntensity, maxIntensity === -Infinity ? 255 : maxIntensity],
    elevationRange: [bounds.minZ, bounds.maxZ],
    densityPerSqMeter: Number(density.toFixed(2)),
    classCounts
  };

  return { points, metadata };
}

// -------------------------------------------------------------
// 2. Stanford PLY Reader (Binary & ASCII)
// -------------------------------------------------------------
export function parsePlyFile(buffer: ArrayBuffer, filename = 'cloud.ply'): ParseResult {
  const textDecoder = new TextDecoder('utf-8');
  // Read first 2KB for header
  const headerSlice = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 4096)));
  const headerText = textDecoder.decode(headerSlice);

  const endHeaderIdx = headerText.indexOf('end_header\n');
  if (endHeaderIdx === -1) {
    throw new Error('Invalid PLY file: could not find end_header keyword');
  }

  const header = headerText.substring(0, endHeaderIdx);
  const isBinaryLittle = header.includes('format binary_little_endian');
  const isAscii = header.includes('format ascii');

  // Extract vertex count
  const vertexMatch = header.match(/element\s+vertex\s+(\d+)/);
  if (!vertexMatch) {
    throw new Error('Invalid PLY file: no vertex element count');
  }
  const pointCount = parseInt(vertexMatch[1], 10);

  // Parse property list
  const lines = header.split('\n');
  const properties: { name: string; type: string }[] = [];
  let inVertex = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('element vertex')) {
      inVertex = true;
    } else if (trimmed.startsWith('element ') && !trimmed.startsWith('element vertex')) {
      inVertex = false;
    } else if (inVertex && trimmed.startsWith('property')) {
      const parts = trimmed.split(/\s+/);
      properties.push({ type: parts[1], name: parts[2] });
    }
  }

  const points: LidarPoint[] = [];
  const classCounts: Record<number, number> = {};
  let minZ = Infinity, maxZ = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minIntensity = Infinity, maxIntensity = -Infinity;
  let hasRGB = false;

  if (isAscii) {
    // ASCII parsing
    const fullText = textDecoder.decode(buffer);
    const dataText = fullText.substring(endHeaderIdx + 'end_header\n'.length);
    const dataLines = dataText.split('\n');

    for (let i = 0; i < Math.min(pointCount, dataLines.length); i++) {
      const line = dataLines[i].trim();
      if (!line) continue;
      const tokens = line.split(/\s+/);
      const point: LidarPoint = { x: 0, y: 0, z: 0 };

      properties.forEach((prop, pIdx) => {
        const val = parseFloat(tokens[pIdx]);
        if (prop.name === 'x') point.x = val;
        else if (prop.name === 'y') point.y = val;
        else if (prop.name === 'z') point.z = val;
        else if (prop.name === 'intensity' || prop.name === 'scalar_Intensity') point.intensity = val;
        else if (prop.name === 'red' || prop.name === 'diffuse_red') { point.r = val; hasRGB = true; }
        else if (prop.name === 'green' || prop.name === 'diffuse_green') point.g = val;
        else if (prop.name === 'blue' || prop.name === 'diffuse_blue') point.b = val;
        else if (prop.name === 'classification' || prop.name === 'class') point.classification = Math.round(val);
      });

      if (point.classification === undefined) point.classification = 1;
      classCounts[point.classification] = (classCounts[point.classification] || 0) + 1;

      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      if (point.intensity !== undefined) {
        minIntensity = Math.min(minIntensity, point.intensity);
        maxIntensity = Math.max(maxIntensity, point.intensity);
      }
      points.push(point);
    }
  } else if (isBinaryLittle) {
    // Binary little endian parsing
    const headerByteLength = new TextEncoder().encode(header + 'end_header\n').length;
    const view = new DataView(buffer, headerByteLength);

    // Calculate stride
    const propSizes: Record<string, number> = {
      float: 4, float32: 4, double: 8, float64: 8,
      int: 4, int32: 4, uint: 4, uint32: 4,
      short: 2, int16: 2, ushort: 2, uint16: 2,
      char: 1, int8: 1, uchar: 1, uint8: 1
    };

    let stride = 0;
    const propOffsets: { name: string; type: string; offset: number }[] = [];
    properties.forEach(p => {
      const sz = propSizes[p.type] || 4;
      propOffsets.push({ name: p.name, type: p.type, offset: stride });
      stride += sz;
    });

    const numRecords = Math.min(pointCount, Math.floor((buffer.byteLength - headerByteLength) / stride));
    let byteOff = 0;

    for (let i = 0; i < numRecords; i++) {
      const point: LidarPoint = { x: 0, y: 0, z: 0 };

      propOffsets.forEach(p => {
        let val = 0;
        const o = byteOff + p.offset;
        if (p.type === 'float' || p.type === 'float32') val = view.getFloat32(o, true);
        else if (p.type === 'double' || p.type === 'float64') val = view.getFloat64(o, true);
        else if (p.type === 'uchar' || p.type === 'uint8') val = view.getUint8(o);
        else if (p.type === 'ushort' || p.type === 'uint16') val = view.getUint16(o, true);
        else if (p.type === 'int' || p.type === 'int32') val = view.getInt32(o, true);

        if (p.name === 'x') point.x = val;
        else if (p.name === 'y') point.y = val;
        else if (p.name === 'z') point.z = val;
        else if (p.name === 'intensity' || p.name === 'scalar_Intensity') point.intensity = val;
        else if (p.name === 'red' || p.name === 'diffuse_red') { point.r = val; hasRGB = true; }
        else if (p.name === 'green' || p.name === 'diffuse_green') point.g = val;
        else if (p.name === 'blue' || p.name === 'diffuse_blue') point.b = val;
        else if (p.name === 'classification' || p.name === 'class') point.classification = Math.round(val);
      });

      if (point.classification === undefined) point.classification = 1;
      classCounts[point.classification] = (classCounts[point.classification] || 0) + 1;

      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      if (point.intensity !== undefined) {
        minIntensity = Math.min(minIntensity, point.intensity);
        maxIntensity = Math.max(maxIntensity, point.intensity);
      }
      points.push(point);
      byteOff += stride;
    }
  }

  const bounds: LidarBounds = {
    minX, maxX, minY, maxY, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: Math.abs(maxX - minX),
    sizeY: Math.abs(maxY - minY),
    sizeZ: Math.abs(maxZ - minZ)
  };

  const density = points.length / Math.max(1, bounds.sizeX * bounds.sizeY);

  return {
    points,
    metadata: {
      filename,
      format: 'PLY',
      pointCount: points.length,
      bounds,
      hasRGB,
      hasIntensity: minIntensity !== Infinity,
      hasClassification: true,
      intensityRange: [minIntensity === Infinity ? 0 : minIntensity, maxIntensity === -Infinity ? 255 : maxIntensity],
      elevationRange: [minZ, maxZ],
      densityPerSqMeter: Number(density.toFixed(2)),
      classCounts
    }
  };
}

// -------------------------------------------------------------
// 3. XYZ / PTS / CSV Text Point Cloud Reader
// -------------------------------------------------------------
export function parseXyzFile(text: string, filename = 'cloud.xyz'): ParseResult {
  const lines = text.split('\n');
  const points: LidarPoint[] = [];
  const classCounts: Record<number, number> = {};
  let minZ = Infinity, maxZ = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minIntensity = Infinity, maxIntensity = -Infinity;
  let hasRGB = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    // Split by comma or whitespace
    const parts = line.split(/[,\s]+/).map(p => parseFloat(p));
    if (parts.length < 3 || isNaN(parts[0])) continue;

    const x = parts[0];
    const y = parts[1];
    const z = parts[2];
    let intensity: number | undefined;
    let r: number | undefined;
    let g: number | undefined;
    let b: number | undefined;
    let classification = 1;

    // Check optional columns (XYZ I, XYZ RGB, XYZ I RGB, XYZ I Class, etc.)
    if (parts.length === 4) {
      intensity = parts[3];
    } else if (parts.length === 6) {
      // X Y Z R G B
      r = parts[3]; g = parts[4]; b = parts[5];
      hasRGB = true;
    } else if (parts.length >= 7) {
      intensity = parts[3];
      r = parts[4]; g = parts[5]; b = parts[6];
      hasRGB = true;
      if (parts.length >= 8) classification = Math.round(parts[7]);
    }

    classCounts[classification] = (classCounts[classification] || 0) + 1;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    if (intensity !== undefined) {
      minIntensity = Math.min(minIntensity, intensity);
      maxIntensity = Math.max(maxIntensity, intensity);
    }

    points.push({ x, y, z, intensity, classification, r, g, b });
  }

  const bounds: LidarBounds = {
    minX, maxX, minY, maxY, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: Math.abs(maxX - minX),
    sizeY: Math.abs(maxY - minY),
    sizeZ: Math.abs(maxZ - minZ)
  };

  const density = points.length / Math.max(1, bounds.sizeX * bounds.sizeY);

  return {
    points,
    metadata: {
      filename,
      format: 'XYZ',
      pointCount: points.length,
      bounds,
      hasRGB,
      hasIntensity: minIntensity !== Infinity,
      hasClassification: true,
      intensityRange: [minIntensity === Infinity ? 0 : minIntensity, maxIntensity === -Infinity ? 255 : maxIntensity],
      elevationRange: [minZ, maxZ],
      densityPerSqMeter: Number(density.toFixed(2)),
      classCounts
    }
  };
}

// -------------------------------------------------------------
// 4. Exporter: Binary ASPRS LAS 1.2
// -------------------------------------------------------------
export function exportToLas(points: LidarPoint[], bounds: LidarBounds): Blob {
  const headerSize = 227;
  const pointRecordLength = 28; // Format 2: XYZ, Intensity, Flags, Class, ScanAngle, User, SourceID, RGB (28 bytes)
  const offsetToPointData = 227;
  const totalByteLength = offsetToPointData + points.length * pointRecordLength;

  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);

  // 'LASF'
  view.setUint8(0, 'L'.charCodeAt(0));
  view.setUint8(1, 'A'.charCodeAt(0));
  view.setUint8(2, 'S'.charCodeAt(0));
  view.setUint8(3, 'F'.charCodeAt(0));

  view.setUint8(24, 1); // Ver Major 1
  view.setUint8(25, 2); // Ver Minor 2

  view.setUint16(94, headerSize, true);
  view.setUint32(96, offsetToPointData, true);
  view.setUint8(104, 2); // Point Format 2 (with RGB)
  view.setUint16(105, pointRecordLength, true);
  view.setUint32(107, points.length, true);

  // Scales & Offsets
  const scale = 0.001; // millimeter resolution
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);

  view.setFloat64(155, bounds.centerX, true);
  view.setFloat64(163, bounds.centerY, true);
  view.setFloat64(171, bounds.centerZ, true);

  view.setFloat64(179, bounds.maxX, true);
  view.setFloat64(187, bounds.minX, true);
  view.setFloat64(195, bounds.maxY, true);
  view.setFloat64(203, bounds.minY, true);
  view.setFloat64(211, bounds.maxZ, true);
  view.setFloat64(219, bounds.minZ, true);

  // Write points
  let ptr = offsetToPointData;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const rawX = Math.round((p.x - bounds.centerX) / scale);
    const rawY = Math.round((p.y - bounds.centerY) / scale);
    const rawZ = Math.round((p.z - bounds.centerZ) / scale);

    view.setInt32(ptr, rawX, true);
    view.setInt32(ptr + 4, rawY, true);
    view.setInt32(ptr + 8, rawZ, true);
    view.setUint16(ptr + 12, p.intensity ?? 128, true);

    const retFlags = (p.returnNumber ?? 1) | ((p.numberOfReturns ?? 1) << 3);
    view.setUint8(ptr + 14, retFlags);
    view.setUint8(ptr + 15, p.classification ?? 1);
    view.setInt8(ptr + 16, 0); // Scan angle
    view.setUint8(ptr + 17, 0); // User data
    view.setUint16(ptr + 18, 1, true); // Source ID

    // RGB (16-bit uints: 0-65535)
    const r16 = (p.r ?? 180) * 256;
    const g16 = (p.g ?? 180) * 256;
    const b16 = (p.b ?? 180) * 256;
    view.setUint16(ptr + 20, r16, true);
    view.setUint16(ptr + 22, g16, true);
    view.setUint16(ptr + 24, b16, true);

    ptr += pointRecordLength;
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}

// -------------------------------------------------------------
// 5. Exporter: Stanford PLY Binary
// -------------------------------------------------------------
export function exportToPly(points: LidarPoint[]): Blob {
  const header = `ply
format binary_little_endian 1.0
comment Exported from AI Cloud LiDAR Studio
element vertex ${points.length}
property float x
property float y
property float z
property ushort intensity
property uchar classification
property uchar red
property uchar green
property uchar blue
end_header
`;
  const headerBytes = new TextEncoder().encode(header);
  const stride = 4 + 4 + 4 + 2 + 1 + 1 + 1 + 1; // 18 bytes
  const buffer = new ArrayBuffer(headerBytes.byteLength + points.length * stride);

  new Uint8Array(buffer).set(headerBytes);
  const view = new DataView(buffer, headerBytes.byteLength);

  let ptr = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    view.setFloat32(ptr, p.x, true);
    view.setFloat32(ptr + 4, p.y, true);
    view.setFloat32(ptr + 8, p.z, true);
    view.setUint16(ptr + 12, p.intensity ?? 128, true);
    view.setUint8(ptr + 14, p.classification ?? 1);
    view.setUint8(ptr + 15, p.r ?? 200);
    view.setUint8(ptr + 16, p.g ?? 200);
    view.setUint8(ptr + 17, p.b ?? 200);
    ptr += stride;
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}

// -------------------------------------------------------------
// 6. Exporter: XYZ ASCII / CSV
// -------------------------------------------------------------
export function exportToXyz(points: LidarPoint[]): Blob {
  let content = '# X Y Z Intensity Classification Red Green Blue\n';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    content += `${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)} ${p.intensity ?? 0} ${p.classification ?? 1} ${p.r ?? 255} ${p.g ?? 255} ${p.b ?? 255}\n`;
  }
  return new Blob([content], { type: 'text/plain' });
}
