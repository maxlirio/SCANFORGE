/**
 * Real-time capture quality checks, computed on a downscaled copy of the frame.
 *
 * Everything here is measured from pixels — nothing is guessed. All three signals
 * are cheap enough to run several times a second on a phone:
 *   sharpness  variance of the Laplacian (the standard blur proxy)
 *   exposure   mean luma plus the fraction of clipped pixels
 *   motion     mean absolute difference against the previous analysed frame
 */

export interface FrameStats {
  sharpness: number;
  brightness: number;
  clippedFraction: number;
  motion: number;
}

export interface QualityVerdict {
  ok: boolean;
  warnings: string[];
  /** Reasons that should block an automatic capture (but never a manual one). */
  blocking: string[];
  stats: FrameStats;
}

const ANALYSIS_WIDTH = 192;

export class FrameAnalyser {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private previous: Float32Array | null = null;
  private height = 0;

  constructor() {
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(ANALYSIS_WIDTH, ANALYSIS_WIDTH)
        : document.createElement('canvas');
    const ctx = (this.canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is unavailable in this browser');
    this.ctx = ctx as CanvasRenderingContext2D;
  }

  analyse(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): FrameStats {
    if (!sourceWidth || !sourceHeight) {
      return { sharpness: 0, brightness: 0, clippedFraction: 0, motion: 0 };
    }
    const height = Math.max(1, Math.round((ANALYSIS_WIDTH * sourceHeight) / sourceWidth));
    if (this.canvas.width !== ANALYSIS_WIDTH || this.canvas.height !== height) {
      this.canvas.width = ANALYSIS_WIDTH;
      this.canvas.height = height;
      this.previous = null;
      this.height = height;
    }
    this.ctx.drawImage(source, 0, 0, ANALYSIS_WIDTH, height);
    const { data } = this.ctx.getImageData(0, 0, ANALYSIS_WIDTH, height);

    const luma = new Float32Array(ANALYSIS_WIDTH * height);
    let sum = 0;
    let clipped = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      luma[p] = y;
      sum += y;
      if (y > 250 || y < 5) clipped += 1;
    }
    const count = luma.length;
    const brightness = sum / count;

    // Variance of the Laplacian over the interior pixels.
    let lapSum = 0;
    let lapSquares = 0;
    let lapCount = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < ANALYSIS_WIDTH - 1; x += 1) {
        const i = y * ANALYSIS_WIDTH + x;
        const v =
          luma[i - ANALYSIS_WIDTH] + luma[i + ANALYSIS_WIDTH] +
          luma[i - 1] + luma[i + 1] - 4 * luma[i];
        lapSum += v;
        lapSquares += v * v;
        lapCount += 1;
      }
    }
    const mean = lapSum / Math.max(lapCount, 1);
    const sharpness = lapSquares / Math.max(lapCount, 1) - mean * mean;

    let motion = 0;
    if (this.previous && this.previous.length === luma.length) {
      let diff = 0;
      for (let i = 0; i < luma.length; i += 4) diff += Math.abs(luma[i] - this.previous[i]);
      motion = diff / (luma.length / 4);
    }
    this.previous = luma;

    return { sharpness, brightness, clippedFraction: clipped / count, motion };
  }
}

/** Thresholds tuned against phone captures; deliberately forgiving. */
export function judge(stats: FrameStats): QualityVerdict {
  const warnings: string[] = [];
  const blocking: string[] = [];

  if (stats.brightness < 45) {
    warnings.push('Too dark — photogrammetry needs even, bright light');
    blocking.push('dark');
  } else if (stats.brightness > 225) {
    warnings.push('Over-exposed — blown-out surfaces cannot be reconstructed');
  }
  if (stats.clippedFraction > 0.35) {
    warnings.push('Heavy glare or deep shadow in frame');
  }
  if (stats.motion > 9) {
    warnings.push('Moving too fast — slow down');
    blocking.push('motion');
  }
  if (stats.sharpness < 12) {
    warnings.push('Blurry — hold steady and let the camera focus');
    blocking.push('blur');
  }

  return { ok: warnings.length === 0, warnings, blocking, stats };
}

/** Same sharpness metric for still images the user uploaded. */
export async function analyseImageFile(file: File): Promise<FrameStats> {
  const bitmap = await createImageBitmap(file);
  try {
    const analyser = new FrameAnalyser();
    return analyser.analyse(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
