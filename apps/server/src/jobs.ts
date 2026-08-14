/**
 * Job lifecycle: create -> receive images -> queue -> run -> publish.
 *
 * Reconstruction is CPU-saturating, so jobs run one at a time by default and
 * queued jobs are told their real position rather than being left spinning.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  JobOptions, JobRecord, LogLine, PipelineEvent, StageState,
} from '@scanforge/shared';
import { DEFAULT_STAGES } from '@scanforge/shared';
import type { Storage } from './storage.js';
import type { ReconstructionProvider } from './providers/types.js';
import { config } from './config.js';

const MAX_LOG_LINES = 400;

function freshStages(): StageState[] {
  return DEFAULT_STAGES.map((s) => ({
    id: s.id, group: s.group, status: 'pending', progress: null, message: s.label,
  }));
}

export class JobManager {
  private readonly bus = new EventEmitter();
  private readonly running = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private active = 0;

  constructor(
    private readonly storage: Storage,
    private readonly providers: Map<string, ReconstructionProvider>,
  ) {
    this.bus.setMaxListeners(0);
  }

  async create(options: Partial<JobOptions>): Promise<JobRecord> {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const now = Date.now();
    const record: JobRecord = {
      id,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      options: {
        provider: options.provider ?? config.defaultProvider,
        quality: options.quality ?? config.defaultQuality,
        mode: options.mode ?? 'object',
        matcher: options.matcher ?? 'auto',
      },
      imageCount: 0,
      stages: freshStages(),
      logs: [],
      files: [],
    };
    await this.storage.ensureJob(id);
    await this.storage.saveJob(record);
    return record;
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.storage.loadJob(id);
  }

  async list(limit = 30): Promise<JobRecord[]> {
    return this.storage.listJobs(limit);
  }

  subscribe(id: string, listener: (job: JobRecord) => void): () => void {
    const channel = `job:${id}`;
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  private async publish(record: JobRecord): Promise<void> {
    record.updatedAt = Date.now();
    await this.storage.saveJob(record);
    this.bus.emit(`job:${record.id}`, record);
  }

  private appendLog(record: JobRecord, level: LogLine['level'], message: string): void {
    record.logs.push({ level, message, ts: Date.now() });
    if (record.logs.length > MAX_LOG_LINES) {
      record.logs.splice(0, record.logs.length - MAX_LOG_LINES);
    }
  }

  /** Fold one provider event into the job's stage table. */
  private applyEvent(record: JobRecord, event: PipelineEvent): void {
    if (event.type === 'stage') {
      let stage = record.stages.find((s) => s.id === event.stage);
      if (!stage) {
        stage = { id: event.stage, group: event.group, status: 'pending', progress: null, message: '' };
        record.stages.push(stage);
      }
      stage.group = event.group;
      stage.message = event.message;
      stage.progress = event.progress;
      if (event.status === 'start') stage.status = 'active';
      if (event.status === 'progress') stage.status = 'active';
      if (event.status === 'end') {
        stage.status = 'done';
        stage.progress = 1;
        if (event.seconds !== undefined) stage.seconds = event.seconds;
      }
    } else if (event.type === 'log') {
      this.appendLog(record, event.level, event.message);
    } else if (event.type === 'result') {
      record.result = event.result;
    } else if (event.type === 'error') {
      record.error = { message: event.message, detail: event.detail };
      this.appendLog(record, 'error', event.message);
    }
  }

  async start(id: string): Promise<JobRecord> {
    const record = await this.storage.loadJob(id);
    if (!record) throw new Error('job not found');
    if (record.status === 'running' || record.status === 'queued') return record;

    const provider = this.providers.get(record.options.provider);
    if (!provider) throw new Error(`Unknown provider: ${record.options.provider}`);

    const images = await this.storage.listImages(id);
    record.imageCount = images.length;
    const needed = provider.minPhotos ?? 8;
    if (images.length < needed) {
      throw new Error(
        `${provider.label} needs at least ${needed} photo${needed === 1 ? '' : 's'} `
        + `(received ${images.length}).`);
    }

    record.status = 'queued';
    record.stages = freshStages();
    record.error = undefined;
    record.result = undefined;
    record.files = [];
    this.queue.push(id);
    record.queuePosition = this.queue.indexOf(id);
    this.appendLog(record, 'info',
      `Queued with ${images.length} photos on provider "${provider.id}".`);
    await this.publish(record);
    void this.pump();
    return record;
  }

  async cancel(id: string): Promise<void> {
    const controller = this.running.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    const queued = this.queue.indexOf(id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      const record = await this.storage.loadJob(id);
      if (record) {
        record.status = 'cancelled';
        await this.publish(record);
      }
      await this.refreshQueuePositions();
    }
  }

  private async refreshQueuePositions(): Promise<void> {
    for (const [index, id] of this.queue.entries()) {
      const record = await this.storage.loadJob(id);
      if (record && record.status === 'queued' && record.queuePosition !== index) {
        record.queuePosition = index;
        await this.publish(record);
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.active >= config.concurrency) return;
    const id = this.queue.shift();
    if (!id) return;
    this.active += 1;
    await this.refreshQueuePositions();
    try {
      await this.execute(id);
    } finally {
      this.active -= 1;
      void this.pump();
    }
  }

  private async execute(id: string): Promise<void> {
    const record = await this.storage.loadJob(id);
    if (!record) return;
    const provider = this.providers.get(record.options.provider);
    if (!provider) return;

    const controller = new AbortController();
    this.running.set(id, controller);
    record.status = 'running';
    record.startedAt = Date.now();
    record.queuePosition = undefined;
    await this.publish(record);

    // Provider events arrive faster than disk writes are worth doing, so we
    // coalesce publishes on a short timer while always keeping state correct.
    let dirty = false;
    const flush = setInterval(() => {
      if (dirty) {
        dirty = false;
        void this.publish(record);
      }
    }, 250);

    try {
      await provider.run({
        jobId: id,
        imagesDir: this.storage.imagesDir(id),
        workDir: this.storage.workDir(id),
        outDir: this.storage.outDir(id),
        options: record.options,
        imageCount: record.imageCount,
        signal: controller.signal,
        emit: (event) => {
          this.applyEvent(record, event);
          dirty = true;
        },
      });
      record.status = 'succeeded';
      record.files = await this.storage.listOutputs(id);
      // The scratch directory is the bulk of a scan's disk use and is worthless
      // once the outputs exist.
      await this.storage.clearWork(id).catch(() => undefined);
      for (const stage of record.stages) {
        if (stage.status === 'active') stage.status = 'done';
      }
      this.appendLog(record, 'info', 'Reconstruction finished.');
    } catch (err) {
      const error = err as Error & { cancelled?: boolean; detail?: string };
      if (error.cancelled || controller.signal.aborted) {
        record.status = 'cancelled';
        this.appendLog(record, 'warn', 'Cancelled.');
      } else {
        record.status = 'failed';
        record.error = { message: error.message, detail: error.detail };
        this.appendLog(record, 'error', error.message);
      }
      record.files = await this.storage.listOutputs(id);
    } finally {
      clearInterval(flush);
      this.running.delete(id);
      record.finishedAt = Date.now();
      await this.publish(record);
      const pruned = await this.storage.prune(config.jobRetentionDays, config.maxJobs)
        .catch(() => [] as string[]);
      if (pruned.length) {
        console.info(`pruned ${pruned.length} old scan(s)`);
      }
    }
  }

  /** A job left 'running' in storage means the process died under it. */
  async reconcileOnBoot(): Promise<void> {
    await this.storage.prune(config.jobRetentionDays, config.maxJobs).catch(() => undefined);
    const jobs = await this.storage.listJobs(200);
    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = { message: 'The server restarted while this scan was processing.' };
        await this.storage.saveJob(job);
      }
    }
  }
}
