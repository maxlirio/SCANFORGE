/**
 * Contract shared by the browser, the API and the reconstruction pipeline.
 *
 * The Python pipeline emits `PipelineEvent`s as newline-delimited JSON on stdout;
 * the server folds them into a `JobRecord` and republishes it over SSE. Anything
 * a provider cannot report honestly stays `null` — see the progress rule below.
 */

/** Internal pipeline steps. Several map onto the same user-visible group. */
export type StageId =
  | 'preparing'
  | 'features'
  | 'matching'
  | 'sparse'
  | 'filtering'
  | 'dense'
  | 'meshing'
  | 'texturing'
  | 'packaging';

/** The four server-side groups the UI shows (capture is the fifth, client-side). */
export type StageGroup = 'preparing' | 'geometry' | 'texture' | 'packaging';

export const STAGE_GROUP_LABELS: Record<StageGroup, string> = {
  preparing: 'Preparing images',
  geometry: 'Reconstructing geometry',
  texture: 'Generating texture',
  packaging: 'Building final model',
};

export const STAGE_GROUP_ORDER: StageGroup[] = ['preparing', 'geometry', 'texture', 'packaging'];

export type JobStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  message: string;
  ts: number;
}

/**
 * Progress rule: `progress` is a fraction in [0,1] ONLY when the underlying tool
 * reported a real counter. `null` means "running, no honest estimate available"
 * and the UI must render an indeterminate indicator, never a fabricated number.
 */
export interface StageState {
  id: StageId;
  group: StageGroup;
  status: 'pending' | 'active' | 'done';
  progress: number | null;
  message: string;
  seconds?: number;
}

export interface GroupState {
  group: StageGroup;
  label: string;
  status: 'pending' | 'active' | 'done';
  stages: StageState[];
}

/** Raw events emitted by a provider (mirrors pipeline/scanforge/events.py). */
export type PipelineEvent =
  | {
      type: 'stage';
      stage: StageId;
      group: StageGroup;
      status: 'start' | 'progress' | 'end';
      progress: number | null;
      message: string;
      seconds?: number;
      ts: number;
    }
  | { type: 'log'; level: LogLevel; message: string; ts: number }
  | { type: 'result'; result: ReconstructionResult; ts: number }
  | { type: 'error'; message: string; detail?: string; ts: number };

export interface OutputFile {
  name: string;
  bytes: number;
  /** Primary = the file the viewer loads and the download button defaults to. */
  primary?: boolean;
  label?: string;
}

export interface ImageReport {
  name: string;
  width: number;
  height: number;
  sharpness: number;
  brightness: number;
  kept: boolean;
  reason?: string;
}

export interface ReconstructionResult {
  tier: string;
  quality: string;
  mode: string;
  matcher?: string;
  photosSubmitted: number;
  photosUsed: number;
  photosRegistered: number;
  points: number;
  vertices: number;
  triangles: number;
  textured: boolean;
  textureFile?: string | null;
  glbBytes: number;
  upAxisConfidence?: number;
  upAxisMethod?: string;
  objectIsolation?: Record<string, unknown>;
  scaleNote?: string;
  durationSeconds: number;
  files: OutputFile[];
  imageReports?: ImageReport[];
  colmap?: Record<string, unknown>;
  /** Set by providers that generate rather than measure geometry. */
  generative?: boolean;
  providerNotes?: string[];
}

export interface JobOptions {
  provider: string;
  quality: 'fast' | 'balanced' | 'high';
  mode: 'object' | 'scene';
  matcher?: 'auto' | 'exhaustive' | 'sequential';
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  options: JobOptions;
  imageCount: number;
  /** Position in the queue when status === 'queued' (0 = next). */
  queuePosition?: number;
  stages: StageState[];
  logs: LogLine[];
  result?: ReconstructionResult;
  files: OutputFile[];
  error?: { message: string; detail?: string };
}

export interface ProviderStatus {
  id: string;
  label: string;
  description: string;
  available: boolean;
  reason?: string;
  /** Free-form facts worth showing the operator, e.g. COLMAP version / CUDA. */
  details?: Record<string, unknown>;
  /** True when the provider invents unobserved geometry (AI image-to-3D). */
  generative?: boolean;
  requiresNetwork?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  defaultProvider: string;
  providers: ProviderStatus[];
  maxImages: number;
  maxUploadBytes: number;
}

export const DEFAULT_STAGES: { id: StageId; group: StageGroup; label: string }[] = [
  { id: 'preparing', group: 'preparing', label: 'Checking and resizing photos' },
  { id: 'features', group: 'geometry', label: 'Detecting features' },
  { id: 'matching', group: 'geometry', label: 'Matching photos' },
  { id: 'sparse', group: 'geometry', label: 'Solving camera positions' },
  { id: 'filtering', group: 'geometry', label: 'Cleaning the point cloud' },
  { id: 'dense', group: 'geometry', label: 'Densifying' },
  { id: 'meshing', group: 'geometry', label: 'Building the surface' },
  { id: 'texturing', group: 'texture', label: 'Projecting photos onto the surface' },
  { id: 'packaging', group: 'packaging', label: 'Writing GLB / OBJ / PLY' },
];

export function groupStages(stages: StageState[]): GroupState[] {
  return STAGE_GROUP_ORDER.map((group) => {
    const inGroup = stages.filter((s) => s.group === group);
    const status: GroupState['status'] = inGroup.some((s) => s.status === 'active')
      ? 'active'
      : inGroup.length > 0 && inGroup.every((s) => s.status === 'done')
        ? 'done'
        : inGroup.some((s) => s.status === 'done')
          ? 'active'
          : 'pending';
    return { group, label: STAGE_GROUP_LABELS[group], status, stages: inGroup };
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
