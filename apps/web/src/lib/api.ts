import type { EngineEvent, EngineState, HealthResponse, JobOptions, JobRecord } from '@scanforge/shared';
import { getApiBase } from './backend';

/** Same-origin when the SCANFORGE server serves this page; absolute otherwise. */
const base = () => `${getApiBase()}/api`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  async health(): Promise<HealthResponse> {
    return json<HealthResponse>(await fetch(`${base()}/health`));
  },

  async createJob(options: Partial<JobOptions>): Promise<JobRecord> {
    return json<JobRecord>(
      await fetch(`${base()}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      }),
    );
  },

  /** Uploads in batches so a phone on flaky wifi makes visible progress. */
  async uploadPhotos(
    jobId: string,
    files: Blob[],
    onProgress: (sent: number, total: number) => void,
    batchSize = 5,
  ): Promise<number> {
    let sent = 0;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const form = new FormData();
      batch.forEach((blob, index) => {
        form.append('photos', blob, `photo_${String(i + index).padStart(4, '0')}.jpg`);
      });
      const res = await fetch(`${base()}/jobs/${jobId}/images`, { method: 'POST', body: form });
      await json<{ saved: number; total: number }>(res);
      sent += batch.length;
      onProgress(sent, files.length);
    }
    return sent;
  },

  async startJob(jobId: string): Promise<JobRecord> {
    return json<JobRecord>(await fetch(`${base()}/jobs/${jobId}/start`, { method: 'POST' }));
  },

  async getJob(jobId: string): Promise<JobRecord> {
    return json<JobRecord>(await fetch(`${base()}/jobs/${jobId}`));
  },

  async listJobs(): Promise<Omit<JobRecord, 'logs'>[]> {
    return json<Omit<JobRecord, 'logs'>[]>(await fetch(`${base()}/jobs`));
  },

  async cancelJob(jobId: string): Promise<void> {
    await fetch(`${base()}/jobs/${jobId}/cancel`, { method: 'POST' });
  },

  async deleteJob(jobId: string): Promise<void> {
    await fetch(`${base()}/jobs/${jobId}`, { method: 'DELETE' });
  },

  async engineState(): Promise<EngineState> {
    return json<EngineState>(await fetch(`${base()}/engine`));
  },

  async installEngine(): Promise<EngineState> {
    return json<EngineState>(await fetch(`${base()}/engine/install`, { method: 'POST' }));
  },

  /** Live setup progress. */
  streamEngine(onEvent: (event: EngineEvent) => void): () => void {
    const source = new EventSource(`${base()}/engine/events`);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data) as EngineEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => source.close();
  },

  fileUrl(jobId: string, name: string, download = false): string {
    return `${base()}/jobs/${jobId}/files/${name}${download ? '?download=1' : ''}`;
  },

  /** Live job updates. Each message is a complete JobRecord snapshot. */
  streamJob(jobId: string, onJob: (job: JobRecord) => void, onError?: () => void): () => void {
    const source = new EventSource(`${base()}/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      try {
        onJob(JSON.parse(event.data) as JobRecord);
      } catch {
        /* ignore malformed frames */
      }
    };
    source.onerror = () => onError?.();
    return () => source.close();
  },
};
