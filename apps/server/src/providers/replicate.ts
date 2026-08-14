/**
 * Optional provider: hosted GPU inference via Replicate.
 *
 * Default target is TRELLIS (MIT-licensed model, image-to-3D) which returns a
 * textured GLB. Unlike the photogrammetry provider this one *generates* geometry
 * — it invents the parts of the object the photos never showed — so it is flagged
 * `generative: true` and the UI says so next to the result.
 *
 * STATUS: implemented against Replicate's documented HTTP API. It has NOT been
 * executed in this repository because that requires a funded Replicate account.
 * Treat it as an unverified integration until you run it with a real token; the
 * default provider is the local one for exactly this reason.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProviderStatus } from '@scanforge/shared';
import { config } from '../config.js';
import type { ReconstructionProvider, RunContext } from './types.js';

const API = 'https://api.replicate.com/v1';

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string;
  logs?: string;
  urls?: { get?: string; cancel?: string };
}

export class ReplicateProvider implements ReconstructionProvider {
  readonly id = 'replicate';
  readonly label = 'Hosted GPU (Replicate)';
  readonly description =
    'Sends your photos to Replicate and runs an image-to-3D model on their GPUs. ' +
    'Fast and robust, but it generates plausible geometry rather than measuring yours, ' +
    'and your photos leave this machine.';

  async probe(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: this.id,
      label: this.label,
      description: this.description,
      available: false,
      generative: true,
      requiresNetwork: true,
      details: { model: config.replicate.model, verified: false },
    };
    if (!config.replicate.token) {
      return { ...base, reason: 'Set REPLICATE_API_TOKEN to enable this provider.' };
    }
    try {
      const res = await fetch(`${API}/models/${config.replicate.model}`, {
        headers: { Authorization: `Bearer ${config.replicate.token}` },
      });
      if (!res.ok) {
        return { ...base, reason: `Replicate said ${res.status} for ${config.replicate.model}` };
      }
      const model = (await res.json()) as { latest_version?: { id?: string } };
      return {
        ...base,
        available: true,
        details: {
          model: config.replicate.model,
          version: config.replicate.version || model.latest_version?.id || 'latest',
          verified: false,
        },
      };
    } catch (err) {
      return { ...base, reason: `Cannot reach Replicate: ${(err as Error).message}` };
    }
  }

  private async imagesAsDataUris(dir: string, limit: number): Promise<string[]> {
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    const chosen = names.length <= limit
      ? names
      : Array.from({ length: limit }, (_, i) => names[Math.floor((i * names.length) / limit)]);
    const uris: string[] = [];
    for (const name of chosen) {
      const buf = await fs.readFile(path.join(dir, name));
      const mime = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      uris.push(`data:${mime};base64,${buf.toString('base64')}`);
    }
    return uris;
  }

  async run(ctx: RunContext): Promise<void> {
    const { token, model, version, imagesField, pollMs } = config.replicate;
    if (!token) throw new Error('REPLICATE_API_TOKEN is not set');

    ctx.emit({
      type: 'stage', stage: 'preparing', group: 'preparing', status: 'start',
      progress: null, message: 'Encoding photos for upload', ts: Date.now() / 1000,
    });
    // Multi-image conditioning models take a handful of views, not a whole capture.
    const images = await this.imagesAsDataUris(ctx.imagesDir, 8);
    ctx.emit({
      type: 'stage', stage: 'preparing', group: 'preparing', status: 'end',
      progress: 1, message: `${images.length} photos encoded`, ts: Date.now() / 1000,
    });

    const endpoint = version ? `${API}/predictions` : `${API}/models/${model}/predictions`;
    const body = version
      ? { version, input: { [imagesField]: images } }
      : { input: { [imagesField]: images } };

    ctx.emit({
      type: 'stage', stage: 'meshing', group: 'geometry', status: 'start',
      progress: null, message: `Queued on Replicate (${model})`, ts: Date.now() / 1000,
    });

    const created = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!created.ok) {
      throw new Error(`Replicate rejected the request (${created.status}): ${await created.text()}`);
    }
    let prediction = (await created.json()) as Prediction;

    let lastLogLine = '';
    while (prediction.status === 'starting' || prediction.status === 'processing') {
      await new Promise((r) => setTimeout(r, pollMs));
      if (ctx.signal.aborted) {
        if (prediction.urls?.cancel) {
          await fetch(prediction.urls.cancel, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          }).catch(() => undefined);
        }
        throw Object.assign(new Error('Reconstruction cancelled'), { cancelled: true });
      }
      const res = await fetch(prediction.urls?.get ?? `${API}/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      prediction = (await res.json()) as Prediction;

      // Report the remote model's own log tail rather than a fabricated percentage.
      const tail = (prediction.logs ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
      if (tail && tail !== lastLogLine) {
        lastLogLine = tail;
        ctx.emit({
          type: 'stage', stage: 'meshing', group: 'geometry', status: 'progress',
          progress: null, message: tail.slice(0, 140), ts: Date.now() / 1000,
        });
      }
    }

    if (prediction.status !== 'succeeded') {
      throw new Error(prediction.error || `Replicate prediction ${prediction.status}`);
    }
    ctx.emit({
      type: 'stage', stage: 'meshing', group: 'geometry', status: 'end',
      progress: 1, message: 'Model generated', ts: Date.now() / 1000,
    });

    const glbUrl = findGlbUrl(prediction.output);
    if (!glbUrl) {
      throw new Error(`No .glb in the model output: ${JSON.stringify(prediction.output).slice(0, 400)}`);
    }

    ctx.emit({
      type: 'stage', stage: 'packaging', group: 'packaging', status: 'start',
      progress: null, message: 'Downloading the model', ts: Date.now() / 1000,
    });
    const download = await fetch(glbUrl, { signal: ctx.signal });
    if (!download.ok) throw new Error(`Could not download the model (${download.status})`);
    const bytes = Buffer.from(await download.arrayBuffer());
    await fs.mkdir(ctx.outDir, { recursive: true });
    await fs.writeFile(path.join(ctx.outDir, 'model.glb'), bytes);
    ctx.emit({
      type: 'stage', stage: 'packaging', group: 'packaging', status: 'end',
      progress: 1, message: 'Model downloaded', ts: Date.now() / 1000,
    });

    ctx.emit({
      type: 'result',
      ts: Date.now() / 1000,
      result: {
        tier: `replicate:${model}`,
        quality: ctx.options.quality,
        mode: ctx.options.mode,
        photosSubmitted: ctx.imageCount,
        photosUsed: images.length,
        photosRegistered: 0,
        points: 0,
        vertices: 0,
        triangles: 0,
        textured: true,
        glbBytes: bytes.length,
        durationSeconds: 0,
        generative: true,
        providerNotes: [
          'Geometry was generated by an AI model, not measured from your photos.',
          'Unobserved surfaces are plausible inventions, and the scale is arbitrary.',
        ],
        files: [{ name: 'model.glb', bytes: bytes.length, primary: true }],
      },
    });
  }
}

/** Model outputs vary in shape; find the first .glb URL anywhere in them. */
function findGlbUrl(output: unknown): string | null {
  if (typeof output === 'string') return output.includes('.glb') ? output : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = findGlbUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    for (const value of Object.values(output as Record<string, unknown>)) {
      const found = findGlbUrl(value);
      if (found) return found;
    }
  }
  return null;
}
