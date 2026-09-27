import express, { Request, Response, NextFunction } from 'express';
import { GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createCloudRouter } from './server/clouds';

dotenv.config();

const execPromise = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// -------------------------------------------------------------
// API Keys & Authentication Store
// -------------------------------------------------------------
interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  usageCount: number;
}

const API_KEYS_FILE = path.join(process.cwd(), '.api_keys.json');
let apiKeys: ApiKeyRecord[] = [];

function loadApiKeys() {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const data = fs.readFileSync(API_KEYS_FILE, 'utf-8');
      apiKeys = JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading api keys:', err);
    apiKeys = [];
  }

  const defaultKeyStr = process.env.BLENDER_STUDIO_API_KEY || 'bldr_live_sec_99a81f3b204e9c78d05';
  if (!apiKeys.some(k => k.key === defaultKeyStr)) {
    apiKeys.unshift({
      id: 'key_master',
      name: 'Default Master Cloud Key',
      key: defaultKeyStr,
      createdAt: new Date().toISOString(),
      usageCount: 0
    });
    saveApiKeys();
  }
}

function saveApiKeys() {
  try {
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving api keys:', err);
  }
}

loadApiKeys();

export function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];
  const queryKey = req.query.api_key as string;

  let providedKey = '';
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    providedKey = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    providedKey = (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader).trim();
  } else if (queryKey) {
    providedKey = queryKey.trim();
  }

  // Allow same-origin internal app client
  const internalClient =
    req.headers['x-requested-by'] === 'lidar-web-client' ||
    req.headers['x-requested-by'] === 'blender-web-client' ||
    req.headers['sec-fetch-site'] === 'same-origin';
  if (internalClient && !providedKey) {
    return next();
  }

  if (!providedKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API Key is required to access the LiDAR Cloud Studio API.',
      instructions: {
        authorization_header: 'Authorization: Bearer <API_KEY>',
        custom_header: 'x-api-key: <API_KEY>',
        query_parameter: '?api_key=<API_KEY>'
      }
    });
  }

  const keyRecord = apiKeys.find(k => k.key === providedKey);
  if (!keyRecord) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid or revoked API Key provided.'
    });
  }

  keyRecord.lastUsedAt = new Date().toISOString();
  keyRecord.usageCount = (keyRecord.usageCount || 0) + 1;
  saveApiKeys();

  (req as any).apiKeyInfo = keyRecord;
  next();
}

// -------------------------------------------------------------
// 1. LLM Agentic API Contract & Endpoints
// -------------------------------------------------------------

// Definition of all Agent Actions and Contract Schema
const AGENT_ACTION_SCHEMA = {
  strip_ground: {
    description: 'Filter out all ground points (ASPRS Class 2) to isolate above-ground vegetation and buildings',
    parameters: {}
  },
  isolate_ground: {
    description: 'Filter all points except Ground (ASPRS Class 2) for bare-earth Digital Terrain Model (DTM)',
    parameters: {}
  },
  isolate_buildings: {
    description: 'Filter all points except Buildings / Structures (ASPRS Class 6)',
    parameters: {}
  },
  isolate_vegetation: {
    description: 'Filter all points except Vegetation canopy (ASPRS Classes 3: Low, 4: Medium, 5: High Vegetation)',
    parameters: {}
  },
  filter_classification: {
    description: 'Enable or disable specific ASPRS classification codes',
    parameters: {
      enabledClasses: 'array of number (e.g. [2, 3, 4, 5, 6, 9])'
    }
  },
  crop_elevation: {
    description: 'Slice the point cloud between minimum and maximum elevation Z values (in meters)',
    parameters: {
      minZ: 'number (optional)',
      maxZ: 'number (optional)'
    }
  },
  crop_roi: {
    description: 'Set 3D Bounding Box Region-of-Interest (ROI) for clipping',
    parameters: {
      minX: 'number',
      maxX: 'number',
      minY: 'number',
      maxY: 'number',
      minZ: 'number',
      maxZ: 'number'
    }
  },
  set_color_mode: {
    description: 'Set viewport shading and coloring mode',
    parameters: {
      mode: "'elevation' | 'intensity' | 'classification' | 'rgb' | 'returns'",
      colormap: "'viridis' | 'turbo' | 'terrain' | 'rainbow' | 'plasma' (optional, used when mode is elevation)"
    }
  },
  decimate: {
    description: 'Downsample point cloud density for fast real-time interaction',
    parameters: {
      rate: 'number (1.0 for 100%, 0.5 for 50%, 0.25 for 25%, 0.1 for 10%)'
    }
  },
  remove_outliers: {
    description: 'Apply Statistical Outlier Removal (SOR) filter to remove floating airborne laser noise',
    parameters: {}
  },
  reset_filters: {
    description: 'Reset all elevation slices, classification filters, and ROI crops back to full dataset',
    parameters: {}
  },
  load_dataset: {
    description: 'Switch active LiDAR dataset',
    parameters: {
      presetId: "'urban_aerial' | 'forest_watershed' | 'highway_bridge' | 'archaeological_mound'"
    }
  }
};

// GET /api/v1/agent/schema - Returns the contract specification
app.get('/api/v1/agent/schema', (req, res) => {
  res.json({
    version: '1.0.0',
    title: 'LiDAR 3D Agentic Operations Schema',
    description: 'Machine-executable contracts for agentic LLM interaction with 3D LiDAR point clouds',
    supportedActions: AGENT_ACTION_SCHEMA,
    asprsClasses: {
      2: 'Ground',
      3: 'Low Vegetation',
      4: 'Medium Vegetation',
      5: 'High Vegetation / Canopy',
      6: 'Building / Structure',
      7: 'Low Point / Noise',
      9: 'Water',
      11: 'Road Surface',
      13: 'Wire Conductor',
      14: 'Transmission Tower',
      17: 'Bridge Deck',
      18: 'High Noise'
    }
  });
});

// POST /api/v1/agent/chat - The Primary LLM Interaction Endpoint
app.post(['/api/v1/agent/chat', '/api/agent/chat'], authenticateApiKey, async (req, res) => {
  const { message, history = [], sceneSummary = {} } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  // If no Gemini API key is configured in user secrets, return clean deterministic response
  if (!apiKey) {
    return res.json(generateLocalFallbackReply(message, sceneSummary));
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `You are the LiDAR Cloud Studio AI Agent, a world-class geospatial and 3D remote sensing engineer.
You interact directly with an active 3D LiDAR point cloud workstation.

CURRENT LIDAR SCENE CONTEXT:
${JSON.stringify(sceneSummary, null, 2)}

SUPPORTED AGENT ACTIONS & CONTRACTS:
1. strip_ground: {} -> Removes ground points (Class 2) so user can see canopy / buildings.
2. isolate_ground: {} -> Keeps only ground (Class 2) for bare-earth Digital Terrain Models (DTM).
3. isolate_buildings: {} -> Keeps only Class 6 buildings.
4. isolate_vegetation: {} -> Keeps only Class 3, 4, 5 vegetation.
5. filter_classification: { enabledClasses: [codes...] } -> Custom class selection.
6. crop_elevation: { minZ?: number, maxZ?: number } -> Elevation slicing in meters.
7. crop_roi: { minX, maxX, minY, maxY, minZ, maxZ } -> 3D Bounding Box clipping.
8. set_color_mode: { mode: "elevation"|"intensity"|"classification"|"rgb"|"returns", colormap?: "viridis"|"turbo"|"terrain"|"rainbow"|"plasma" }
9. decimate: { rate: 0.1 | 0.25 | 0.5 | 1.0 } -> Performance downsampling.
10. remove_outliers: {} -> Statistical Outlier Removal (SOR) to clean airborne noise.
11. reset_filters: {} -> Restores full unclipped cloud.
12. load_dataset: { presetId: "urban_aerial"|"forest_watershed"|"highway_bridge"|"archaeological_mound" }

USER INSTRUCTION: "${message}"

RESPONSE FORMAT:
You MUST respond with a strict JSON object (NO markdown backticks, NO markdown formatting outside JSON):
{
  "reply": "Concise, professional explanation of your geospatial reasoning and what was executed.",
  "actions": [
    {
      "id": "unique_action_id",
      "type": "one_of_the_action_names_above",
      "label": "Short Action Title (e.g. 'Strip Ground Points')",
      "parameters": { ... },
      "explanation": "Brief explanation of this action"
    }
  ],
  "suggestedFollowUps": ["Next question 1", "Next question 2"]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [systemPrompt]
    });

    const rawText = response.text ? response.text.trim() : '';
    const cleanedText = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleanedText);
    return res.json({
      success: true,
      reply: parsed.reply || 'Actions completed.',
      actions: parsed.actions || [],
      suggestedFollowUps: parsed.suggestedFollowUps || []
    });
  } catch (err: any) {
    console.error('Gemini Agent Error:', err);
    // Graceful fallback to deterministic engine
    return res.json(generateLocalFallbackReply(message, sceneSummary));
  }
});

function generateLocalFallbackReply(message: string, sceneSummary: any) {
  const lower = message.toLowerCase();
  const actions: any[] = [];
  let reply = '';
  const suggested: string[] = [];

  if (lower.includes('strip ground') || lower.includes('remove ground') || lower.includes('canopy')) {
    actions.push({
      id: `act_${Date.now()}`,
      type: 'strip_ground',
      label: 'Strip Ground Points',
      parameters: {},
      explanation: 'Filtered out ground points (Class 2) to reveal tree canopy and structures.'
    });
    reply = `Ground points (ASPRS Class 2) have been removed from view. The remaining points display tree canopies, power transmission lines, and structural facades.`;
    suggested.push('Color by elevation with Turbo', 'Isolate buildings only', 'Reset filters');
  } else if (lower.includes('building')) {
    actions.push({
      id: `act_${Date.now()}`,
      type: 'isolate_buildings',
      label: 'Isolate Buildings',
      parameters: {},
      explanation: 'Filtered scan to display exclusively Class 6 structures.'
    });
    reply = `Filtered to show building structural returns (Class 6). Ground and vegetation have been hidden.`;
    suggested.push('Color by height', 'Show all classes', 'Reset filters');
  } else if (lower.includes('ground only') || lower.includes('dtm') || lower.includes('terrain only')) {
    actions.push({
      id: `act_${Date.now()}`,
      type: 'isolate_ground',
      label: 'Isolate Ground (DTM)',
      parameters: {},
      explanation: 'Isolated Ground points (Class 2) for bare-earth Digital Terrain Modeling.'
    });
    reply = `Bare-earth Digital Terrain Model (DTM) isolated. All above-ground foliage and structures are filtered out.`;
    suggested.push('Color by elevation with Terrain colormap', 'Show full cloud');
  } else if (lower.includes('noise') || lower.includes('outlier') || lower.includes('clean')) {
    actions.push({
      id: `act_${Date.now()}`,
      type: 'remove_outliers',
      label: 'Remove Noise Outliers (SOR)',
      parameters: {},
      explanation: 'Statistical Outlier Filter applied to purge stray airborne pulses.'
    });
    reply = `Statistical Outlier Removal (SOR) executed. Isolated laser returns and sensor noise have been purged.`;
    suggested.push('Decimate to 50%', 'Color by intensity');
  } else if (lower.includes('color') || lower.includes('turbo') || lower.includes('viridis') || lower.includes('terrain') || lower.includes('elevation')) {
    let cmap = 'viridis';
    if (lower.includes('turbo')) cmap = 'turbo';
    else if (lower.includes('terrain')) cmap = 'terrain';
    else if (lower.includes('plasma')) cmap = 'plasma';

    actions.push({
      id: `act_${Date.now()}`,
      type: 'set_color_mode',
      label: `Set Colormap to ${cmap.toUpperCase()}`,
      parameters: { mode: 'elevation', colormap: cmap },
      explanation: `Set shading to elevation with ${cmap} colormap.`
    });
    reply = `Viewport color mode updated to elevation gradient using scientific colormap **${cmap.toUpperCase()}**.`;
    suggested.push('Color by intensity', 'Color by classification');
  } else if (lower.includes('reset')) {
    actions.push({
      id: `act_${Date.now()}`,
      type: 'reset_filters',
      label: 'Reset All Filters',
      parameters: {},
      explanation: 'Restored all classes, elevation slices, and bounding boxes.'
    });
    reply = `All filters and ROI slices have been reset. The complete point cloud is displayed.`;
    suggested.push('Strip ground points', 'Analyze survey metrics');
  } else if (lower.includes('density') || lower.includes('count') || lower.includes('metric') || lower.includes('stat')) {
    reply = `Point cloud survey analysis:\n- **Total Point Count:** ${(sceneSummary.pointCount || 38500).toLocaleString()} pts\n- **Point Density:** ${sceneSummary.densityPerSqMeter || 3.85} pts/m²\n- **Z Elevation Range:** ${sceneSummary.elevationRange ? sceneSummary.elevationRange.join('m to ') + 'm' : 'Full range'}\n- **Shading Mode:** ${sceneSummary.colorMode || 'classification'}`;
    suggested.push('Strip ground points', 'Clean noise outliers', 'Decimate to 50%');
  } else {
    reply = `Understood. I can help analyze, filter, and edit this LiDAR dataset. Try asking:
- "Strip ground to inspect canopy"
- "Isolate all buildings"
- "Color by elevation with Turbo"
- "Clean laser noise outliers"`;
    suggested.push('Strip ground points', 'Isolate buildings', 'Color by elevation');
  }

  return {
    success: true,
    reply,
    actions,
    suggestedFollowUps: suggested
  };
}

// -------------------------------------------------------------
// 2. Health & System Status Endpoint
// -------------------------------------------------------------
app.get(['/api/v1/status', '/api/status', '/api/v1/health', '/health'], (req, res) => {
  res.json({
    status: 'online',
    service: 'lidar-cloud-studio',
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      uptimeSec: Math.round(os.uptime())
    },
    capabilities: [
      'LIDAR_LAS_PARSER',
      'LIDAR_PLY_PARSER',
      'LIDAR_XYZ_PARSER',
      'LIDAR_E57_INGEST',
      'ASPRS_CLASSIFICATION_ENGINE',
      'AGENTIC_LLM_INTEGRATION'
    ],
    authenticated: !!(req as any).apiKeyInfo
  });
});

// -------------------------------------------------------------
// 3. API Key Management
// -------------------------------------------------------------
app.get('/api/v1/auth/keys', (req, res) => {
  res.json({
    keys: apiKeys.map(k => ({
      id: k.id,
      name: k.name,
      maskedKey: k.key.substring(0, 10) + '...' + k.key.substring(k.key.length - 4),
      fullKey: k.key,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null,
      usageCount: k.usageCount || 0
    }))
  });
});

app.post('/api/v1/auth/keys', (req, res) => {
  const { name } = req.body;
  const newKey = 'bldr_live_' + crypto.randomBytes(16).toString('hex');
  const record: ApiKeyRecord = {
    id: 'key_' + Date.now(),
    name: name || 'LiDAR API Key ' + (apiKeys.length + 1),
    key: newKey,
    createdAt: new Date().toISOString(),
    usageCount: 0
  };
  apiKeys.push(record);
  saveApiKeys();
  res.status(201).json({ message: 'API key created successfully', key: record });
});

app.delete('/api/v1/auth/keys/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'key_master') {
    return res.status(400).json({ error: 'Cannot delete master key' });
  }
  const idx = apiKeys.findIndex(k => k.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Key not found' });
  }
  apiKeys.splice(idx, 1);
  saveApiKeys();
  res.json({ message: 'API key deleted successfully' });
});

// -------------------------------------------------------------
// 4. Point Cloud Ingest (E57 upload -> conversion -> viewer)
// -------------------------------------------------------------
app.use('/api/v1/clouds', createCloudRouter(authenticateApiKey));

// -------------------------------------------------------------
// Vite Middleware & Static Setup
// -------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`[LiDAR Cloud Studio] Running on http://0.0.0.0:${PORT}`);
    console.log(`[LiDAR Cloud Studio] Agentic LLM endpoint ready at /api/v1/agent/chat`);
  });
}

startServer();
