import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { HealthResponse, JobOptions } from '@scanforge/shared';
import { config, REPO_ROOT } from './config.js';
import { LocalStorage } from './storage.js';
import { JobManager } from './jobs.js';
import { ColmapLocalProvider } from './providers/colmapLocal.js';
import { ReplicateProvider } from './providers/replicate.js';
import type { ReconstructionProvider } from './providers/types.js';

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.ply': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: config.maxUploadBytes,
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: config.maxImages },
  });

  const storage = new LocalStorage(config.dataDir);
  const providerList: ReconstructionProvider[] = [new ColmapLocalProvider(), new ReplicateProvider()];
  const providers = new Map(providerList.map((p) => [p.id, p]));
  const jobs = new JobManager(storage, providers);
  await jobs.reconcileOnBoot();

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const statuses = await Promise.all(providerList.map((p) => p.probe()));
    return {
      ok: statuses.some((s) => s.available),
      version: config.version,
      defaultProvider: config.defaultProvider,
      providers: statuses,
      maxImages: config.maxImages,
      maxUploadBytes: config.maxUploadBytes,
    };
  });

  app.post('/api/jobs', async (request) => {
    const body = (request.body ?? {}) as Partial<JobOptions>;
    return jobs.create(body);
  });

  app.get('/api/jobs', async (request) => {
    const { limit } = request.query as { limit?: string };
    const list = await jobs.list(Math.min(Number(limit) || 30, 100));
    // Strip logs from the index view; the detail endpoint has them.
    return list.map(({ logs, ...rest }) => rest);
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await jobs.get(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await jobs.cancel(id);
    await storage.deleteJob(id);
    return reply.code(204).send();
  });

  /** Photos arrive here, one multipart request per batch. */
  app.post('/api/jobs/:id/images', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await jobs.get(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    if (job.status === 'running' || job.status === 'queued') {
      return reply.code(409).send({ error: 'this scan is already processing' });
    }

    let saved = 0;
    const existing = (await storage.listImages(id)).length;
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      if (existing + saved >= config.maxImages) {
        part.file.resume();
        continue;
      }
      const index = existing + saved;
      const ext = path.extname(part.filename || '.jpg').toLowerCase() || '.jpg';
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext) ? ext : '.jpg';
      await storage.saveImage(id, `photo_${String(index).padStart(4, '0')}${safeExt}`, part.file);
      saved += 1;
    }

    job.imageCount = (await storage.listImages(id)).length;
    await storage.saveJob(job);
    return { saved, total: job.imageCount, max: config.maxImages };
  });

  app.post('/api/jobs/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await jobs.start(id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    await jobs.cancel(id);
    return reply.code(202).send({ ok: true });
  });

  /** Server-sent events: full job snapshots, so a reconnect is always correct. */
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await jobs.get(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (payload: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send(job);

    const unsubscribe = jobs.subscribe(id, send);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  app.get('/api/jobs/:id/files/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const filePath = storage.outputPath(id, name);
    if (!filePath) return reply.code(404).send({ error: 'file not found' });
    const ext = path.extname(name).toLowerCase();
    const stat = fs.statSync(filePath);
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    // Inline for the viewer/thumbnail, attachment when explicitly downloading.
    const download = (request.query as { download?: string }).download === '1';
    if (download) reply.header('Content-Disposition', `attachment; filename="scan_${id}_${name}"`);
    return reply.send(fs.createReadStream(filePath));
  });

  // Serve the built frontend when it exists, so `npm start` is a single process.
  const webDist = path.join(REPO_ROOT, 'apps', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`data directory: ${config.dataDir}`);
  app.log.info(`python: ${config.pythonBin}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
