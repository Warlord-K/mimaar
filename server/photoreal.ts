/**
 * Photoreal pipeline: LiDAR viewport capture -> photorealistic photo (Nano Banana 2) -> video (Gemini Omni).
 *
 * TypeScript port of the lidar2real pipeline (tools/lidar2real). Mounted by server.ts at /api/v1/photoreal.
 * Both models are called through the Gemini Interactions API, which blocks until the media is ready.
 */
import express, { RequestHandler, Response, Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const IMAGE_MODEL = 'gemini-3.1-flash-image'; // Nano Banana 2
export const VIDEO_MODEL = 'gemini-omni-1.1-flash'; // Gemini Omni Flash
export const TEXT_MODEL = 'gemini-flash-latest'; // describes the anchor photo so other views can match its look

const IMAGE_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VIDEO_ASPECTS = ['16:9', '9:16'];
const IMAGE_SIZES = ['512', '1K', '2K', '4K'];
const VIDEO_RESOLUTIONS = ['360p', '720p', '1080p', '4k'];
const INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const IMAGE_TIMEOUT_MS = 300_000;
const VIDEO_TIMEOUT_MS = 1_200_000;

export const DEFAULT_LOOK = 'natural daylight, lightly overcast sky, realistic exposure and white balance';
export const DEFAULT_MOTION = 'a slow, smooth, stabilized forward camera move at walking pace along the main direction of the scene';

// -------------------------------------------------------------
// Prompts (the command-line pipeline has its own copy in tools/lidar2real/lidar2real/prompts.py)
// -------------------------------------------------------------

export type ColorMode = 'elevation' | 'intensity' | 'classification' | 'rgb' | 'returns';

export interface LegendEntry {
  name: string;
  hex: string;
}

export interface RenderPromptOptions {
  source?: 'lidar' | 'blender';
  colorMode?: ColorMode;
  colormap?: string;
  legend?: LegendEntry[]; // visible ASPRS classes, used when colorMode is 'classification'
  scene?: string;
  look?: string;
  anchorLook?: string; // description of the anchor photo that this view should match
}

function colorLines(o: RenderPromptOptions): string {
  const notReal = 'they are NOT the real colors of anything';
  switch (o.colorMode) {
    case 'classification': {
      const legend = (o.legend ?? []).map(l => `${l.hex} = ${l.name}`).join('; ');
      return `- Point colors encode ASPRS classification${legend ? ` (${legend})` : ''}. Use them to tell what each surface is, then render it with its real-world colors; never keep the class colors.`;
    }
    case 'rgb':
      return '- Point colors are the true colors captured by the scanner. Keep those colors and materials.';
    case 'intensity':
      return `- Point colors encode laser return intensity (reflectivity); ${notReal}.`;
    case 'returns':
      return `- Point colors encode the laser return number (first, intermediate, last); ${notReal}.`;
    case 'elevation':
      return `- Point colors encode elevation with the ${o.colormap || 'viridis'} colormap, from low to high; ${notReal}.`;
    default:
      return (
        `- Its colors are false-color encodings of height, intensity or depth; ${notReal}.\n` +
        '- Bright yellow or green highlights only mean high reflectivity (license plates, road signs, painted metal, glass). Never make an object yellow or green because it is highlighted.'
      );
  }
}

function readSection(o: RenderPromptOptions): string {
  if (o.source === 'blender') {
    return `How to read the input:
- It is a 3D render (for example from Blender) that may be untextured, flat-shaded or use placeholder materials.
- Treat it as a blockout: its geometry, layout and camera are ground truth, but its materials, lighting and CG look are not.
- Work out what each shape is in the real world and render it as that real object with real materials.`;
  }
  return `How to read the input:
- It is a LiDAR point-cloud visualization.
${colorLines(o)}
- Black or empty areas are places with no LiDAR returns: usually open sky, or unscanned surroundings. Fill them with what would realistically be there, and never render them as black walls, blocks or voids.
- Dots, gaps, scan lines, concentric rings and stripes are sensor artifacts. Do not reproduce them.
- Work out what each shape is in the real world (thin vertical lines are usually poles, lamp posts or trees; box shapes are usually vehicles, containers or barriers; large vertical planes are building facades or walls) and render it as that real object.`;
}

function sceneLine(scene?: string): string {
  const s = (scene ?? '').trim().replace(/\.$/, '');
  return s ? `Scene: ${s}.\n` : '';
}

export function renderPrompt(o: RenderPromptOptions): string {
  const look = (o.look?.trim() || DEFAULT_LOOK).replace(/\.$/, '');
  let prompt = `Turn this image into a single photorealistic photograph of the same real place, exactly as a real camera standing at this exact position would capture it.

${readSection(o)}

Hard constraints:
- Keep the exact camera position, viewing angle, field of view, horizon and perspective.
- Keep every structure and object in the same place, with the same size, shape and count. Do not add, remove or move buildings, openings, poles or objects.
- Match the viewpoint type exactly. Street-level views become a handheld photo at eye level. Elevated oblique views become a drone photo from the same height and angle.
- A plan view seen from directly above (building footprints, the scanned ground as a band) must become a straight-down aerial photo, never a street-level or oblique shot. The sensor was on the street, so buildings may appear only as wall outlines: render them as solid buildings with roofs.

Photographic look:
- An unedited photograph from a full-frame camera: realistic materials (concrete, brick, glass, asphalt, metal, and vegetation where plausible), physically plausible light and shadows, true-to-life color, fine texture detail, natural depth of field.
- No text, labels, watermarks, borders, UI, outlines, bounding boxes, point-cloud look, glow or neon colors.

${sceneLine(o.scene)}Lighting and conditions: ${look}.`;
  // Consistency across views uses a text description of the anchor photo, not the photo itself:
  // given a reference photo, Nano Banana 2 copies its composition even when told not to.
  if (o.anchorLook?.trim()) {
    prompt += `\n\nThis is one of several photos of the same place taken minutes apart. Match this look exactly; it describes appearance only, so the composition must still come from the input image: ${o.anchorLook.trim()}`;
  }
  return prompt;
}

export const DESCRIBE_LOOK_PROMPT =
  'Describe the look of this place so another photographer could match it: architecture style, facade materials and colors, windows, doors, ground and sidewalk surfaces, street furniture, vehicles (types and colors), vegetation, weather, time of day, light direction and color grading. One dense paragraph, max 120 words. Do not describe the camera position, framing or layout.';

export function clipPrompt(motion?: string, scene?: string): string {
  const m = (motion?.trim() || DEFAULT_MOTION).replace(/\.$/, '');
  return `[# Sources <FIRST_FRAME>@Image1]
Photorealistic real-world footage of this place, shot on a stabilized cinema camera: ${m}.
The scene stays physically consistent with the photo: buildings, poles and objects are rigid and keep their positions; only natural things move, such as light, clouds and leaves.
${sceneLine(scene)}Audio: natural ambient sound of the location only, no music, no voiceover.
No text, captions or watermarks.
Use this image as the starting frame.`;
}

export function transitionPrompt(scene?: string): string {
  return `[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]
One continuous, unbroken camera move through the same real place, travelling smoothly from the viewpoint of the first image to the viewpoint of the second image, like a gimbal or drone shot.
No cuts, dissolves or morphing: the geometry stays rigid and consistent while the camera moves through it. Photorealistic real-world footage.
${sceneLine(scene)}Audio: natural ambient sound of the location only, no music, no voiceover.
No text, captions or watermarks.`;
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface InlineImage {
  data: string; // base64
  mimeType: string;
}

/** Accepts a data URL ("data:image/png;base64,...") or raw base64 plus an optional mimeType. */
export function parseImage(input: unknown, fallbackMime = 'image/png'): InlineImage {
  if (typeof input !== 'string' || input.length < 16) {
    throw new HttpError(400, 'image must be a data URL or base64 string');
  }
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(input);
  const mimeType = m ? m[1] : fallbackMime;
  const data = (m ? m[2] : input).replace(/\s/g, '');
  if (!INPUT_MIME_TYPES.includes(mimeType)) {
    throw new HttpError(400, `unsupported image type ${mimeType}; use ${INPUT_MIME_TYPES.join(', ')}`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new HttpError(400, 'image is not valid base64');
  }
  return { data, mimeType };
}

/** Pick the supported aspect ratio closest to width/height (compared in log space). */
export function nearestAspect(width: number, height: number, options: string[]): string {
  const target = Math.log(width / height);
  let best = options[0];
  let bestDist = Infinity;
  for (const a of options) {
    const [w, h] = a.split(':').map(Number);
    const d = Math.abs(Math.log(w / h) - target);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

/** Width/height from a PNG header, for API callers that don't send dimensions. */
function pngSize(img: InlineImage): [number, number] | null {
  if (img.mimeType !== 'image/png') return null;
  const head = Buffer.from(img.data.slice(0, 44), 'base64');
  if (head.length < 24 || head.toString('ascii', 1, 4) !== 'PNG') return null;
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

function imagePart(img: InlineImage) {
  return { type: 'image' as const, data: img.data, mime_type: img.mimeType as any };
}

function textPart(text: string) {
  return { type: 'text' as const, text };
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new HttpError(503, 'GEMINI_API_KEY is not configured on the server, so photoreal rendering is unavailable.');
  }
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * interactions.create with our own retry policy instead of the SDK's: a 429 caused by a spending cap or billing
 * problem is permanent, so it should fail immediately rather than after minutes of backoff.
 */
async function createInteraction(ai: GoogleGenAI, body: Record<string, any>, timeout: number, retries: number): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.interactions.create(body as any, { timeout, maxRetries: 0 });
    } catch (err: any) {
      const permanent = /spend|billing/i.test(String(err?.message ?? ''));
      if (permanent || !RETRYABLE_STATUS.has(Number(err?.status)) || attempt >= retries) throw err;
      const delay = Math.min(30_000, 2_000 * 2 ** attempt);
      console.warn(`[photoreal] ${body.model} returned ${err.status}, retrying in ${delay / 1000}s (${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function noMedia(model: string, kind: string, interaction: any): HttpError {
  const reason = (interaction?.output_text || '').trim() || 'no explanation returned';
  return new HttpError(502, `${model} returned no ${kind} (status=${interaction?.status}): ${reason}`);
}

async function describeLook(ai: GoogleGenAI, photo: InlineImage): Promise<string> {
  const interaction = await createInteraction(
    ai,
    { model: TEXT_MODEL, input: [imagePart(photo), textPart(DESCRIBE_LOOK_PROMPT)] },
    IMAGE_TIMEOUT_MS,
    3
  );
  const text = (interaction.output_text || '').trim();
  if (!text) throw noMedia(TEXT_MODEL, 'text', interaction);
  return text;
}

/** URI-delivered videos (1080p / 4k) must be polled until ACTIVE, then downloaded. */
async function downloadVideo(ai: GoogleGenAI, uri: string): Promise<string> {
  const name = 'files/' + uri.replace(/\/+$/, '').split('/').pop()!.split('?')[0].split(':')[0];
  const deadline = Date.now() + 600_000;
  for (;;) {
    const file: any = await ai.files.get({ name });
    const state = String(file.state ?? '');
    if (state === 'ACTIVE') break;
    if (state === 'FAILED') throw new HttpError(502, `video file ${name} failed processing`);
    if (Date.now() > deadline) throw new HttpError(504, `video file ${name} still ${state} after 10 minutes`);
    await new Promise(r => setTimeout(r, 5000));
  }
  const tmp = path.join(os.tmpdir(), `photoreal_${crypto.randomBytes(6).toString('hex')}.mp4`);
  try {
    await ai.files.download({ file: uri, downloadPath: tmp });
    return fs.readFileSync(tmp).toString('base64');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function sendError(res: Response, err: any) {
  const ours = err instanceof HttpError;
  const upstream = Number(err?.status);
  const status = ours ? err.status : upstream >= 400 && upstream < 600 ? upstream : 500;
  // Errors we raise are about the request; anything else came back from the Gemini API.
  const label = ours ? (status >= 500 ? 'Generation failed' : 'Bad request') : 'Gemini API error';
  console.error('[photoreal]', status, err?.message || err);
  res.status(status).json({ error: label, message: err?.message || String(err) });
}

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

export function createPhotorealRouter(authenticate: RequestHandler): Router {
  const router = express.Router();

  // GET /api/v1/photoreal/config - models, options and whether a Gemini key is configured
  router.get('/config', (_req, res) => {
    res.json({
      enabled: !!process.env.GEMINI_API_KEY,
      models: { image: IMAGE_MODEL, video: VIDEO_MODEL, describe: TEXT_MODEL },
      imageSizes: IMAGE_SIZES,
      videoResolutions: VIDEO_RESOLUTIONS,
      defaults: { look: DEFAULT_LOOK, motion: DEFAULT_MOTION, imageSize: '2K', resolution: '720p' }
    });
  });

  // POST /api/v1/photoreal/render - one view -> one photorealistic photo
  router.post('/render', authenticate, async (req, res) => {
    try {
      const b = req.body ?? {};
      const img = parseImage(b.image);
      const imageSize = IMAGE_SIZES.includes(b.imageSize) ? b.imageSize : '2K';
      const dims = Number(b.width) > 0 && Number(b.height) > 0 ? [Number(b.width), Number(b.height)] : pngSize(img);
      const aspectRatio = dims ? nearestAspect(dims[0], dims[1], IMAGE_ASPECTS) : undefined;
      const prompt = renderPrompt({
        source: b.source === 'blender' ? 'blender' : 'lidar',
        colorMode: b.colorMode,
        colormap: b.colormap,
        legend: Array.isArray(b.legend) ? b.legend.slice(0, 24) : undefined,
        scene: typeof b.scene === 'string' ? b.scene : '',
        look: typeof b.look === 'string' ? b.look : '',
        anchorLook: typeof b.anchorLook === 'string' ? b.anchorLook : ''
      });

      const ai = getClient();
      const interaction = await createInteraction(
        ai,
        {
          model: IMAGE_MODEL,
          input: [imagePart(img), textPart(prompt)],
          response_format: { type: 'image', image_size: imageSize, ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) }
        },
        IMAGE_TIMEOUT_MS,
        3
      );
      const out = interaction.output_image;
      if (!out?.data) throw noMedia(IMAGE_MODEL, 'image', interaction);
      const photo = { data: out.data as string, mimeType: (out.mime_type as string) || 'image/jpeg' };

      // The anchor view's look is described once and sent back with every other view (anchorLook).
      let look: string | undefined;
      let lookError: string | undefined;
      if (b.returnLook) {
        try {
          look = await describeLook(ai, photo);
        } catch (err: any) {
          lookError = err?.message || String(err);
        }
      }

      res.json({
        success: true,
        image: photo.data,
        mimeType: photo.mimeType,
        aspectRatio: aspectRatio ?? null,
        interactionId: interaction.id ?? null,
        look,
        lookError,
        prompt,
        model: IMAGE_MODEL
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/v1/photoreal/video - 1 frame -> clip starting on it; 2 frames -> camera move from the first to the second
  router.post('/video', authenticate, async (req, res) => {
    try {
      const b = req.body ?? {};
      if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > 2) {
        throw new HttpError(400, 'frames must be an array of 1 or 2 images');
      }
      const frames = b.frames.map((f: unknown) => parseImage(f, 'image/jpeg'));
      const transition = frames.length === 2;
      const resolution = VIDEO_RESOLUTIONS.includes(b.resolution) ? b.resolution : '720p';
      const aspectRatio = VIDEO_ASPECTS.includes(b.aspectRatio) ? b.aspectRatio : '16:9';
      const prompt = transition ? transitionPrompt(b.scene) : clipPrompt(b.motion, b.scene);

      const responseFormat: Record<string, string> = { type: 'video', aspect_ratio: aspectRatio, resolution };
      if (resolution === '1080p' || resolution === '4k') {
        // Inline responses top out around 4 MB; bigger videos must be fetched from a Files API URI.
        responseFormat.delivery = 'uri';
      }
      const body: Record<string, any> = {
        model: VIDEO_MODEL,
        input: [...frames.map(imagePart), textPart(prompt)],
        response_format: responseFormat
      };
      // Clips are plain image-to-video; for first/last-frame transitions Omni infers the task from the prompt tags.
      if (!transition) body.generation_config = { video_config: { task: 'image_to_video' } };

      const ai = getClient();
      const interaction = await createInteraction(ai, body, VIDEO_TIMEOUT_MS, 2);
      const out = interaction.output_video;
      if (!out?.data && !out?.uri) throw noMedia(VIDEO_MODEL, 'video', interaction);
      const video = out.data ?? (await downloadVideo(ai, out.uri));

      res.json({
        success: true,
        video,
        mimeType: out.mime_type || 'video/mp4',
        interactionId: interaction.id ?? null,
        prompt,
        model: VIDEO_MODEL
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
