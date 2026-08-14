import type { JobOptions, PipelineEvent, ProviderStatus } from '@scanforge/shared';

export interface RunContext {
  jobId: string;
  /** Directory of prepared input photographs. */
  imagesDir: string;
  /** Scratch space the provider may fill and the server may clean. */
  workDir: string;
  /** Where the finished model files must be written. */
  outDir: string;
  options: JobOptions;
  imageCount: number;
  emit(event: PipelineEvent): void;
  signal: AbortSignal;
}

/**
 * The one seam that matters: everything about *how* photographs become a model
 * lives behind this. A provider is responsible for writing at least `model.glb`
 * into `outDir` and for emitting honest progress events while it works.
 */
export interface ReconstructionProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  probe(): Promise<ProviderStatus>;
  run(ctx: RunContext): Promise<void>;
}
