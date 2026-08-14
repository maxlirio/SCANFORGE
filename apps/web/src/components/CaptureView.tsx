import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FrameAnalyser, analyseImageFile, judge, type QualityVerdict } from '../lib/frameQuality';
import {
  AZIMUTH_SECTORS, OrientationTracker, cellKey, sectorFor, summarise,
  type ElevationBand,
} from '../lib/coverage';
import { CoverageDial } from './CoverageDial';

export interface CapturedPhoto {
  id: string;
  blob: Blob;
  url: string;
  source: 'camera' | 'upload';
  sharpness: number;
  sector: number | null;
  band: ElevationBand | null;
}

interface Props {
  onFinish(photos: CapturedPhoto[]): void;
  onCancel(): void;
  maxPhotos: number;
}

const MIN_PHOTOS = 8;

export function CaptureView({ onFinish, onCancel, maxPhotos }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<FrameAnalyser | null>(null);
  const trackerRef = useRef<OrientationTracker | null>(null);
  const orientationRef = useRef<{ sector: number | null; band: ElevationBand | null }>({
    sector: null, band: null,
  });
  const autoRef = useRef(false);
  const lastAutoShot = useRef(0);
  const photosRef = useRef<CapturedPhoto[]>([]);

  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'live' | 'denied' | 'unavailable'>('idle');
  const [cameraError, setCameraError] = useState('');
  const [verdict, setVerdict] = useState<QualityVerdict | null>(null);
  const [orientation, setOrientation] = useState<{ sector: number | null; band: ElevationBand | null }>({
    sector: null, band: null,
  });
  const [orientationAvailable, setOrientationAvailable] = useState(false);
  const [auto, setAuto] = useState(false);
  const [flash, setFlash] = useState(false);
  const [cameraSlow, setCameraSlow] = useState(false);
  const [busy, setBusy] = useState('');

  photosRef.current = photos;
  autoRef.current = auto;

  const cells = useMemo(() => {
    const map = new Map<string, number>();
    for (const photo of photos) {
      if (photo.sector === null || photo.band === null) continue;
      const key = cellKey(photo.sector, photo.band);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [photos]);

  const summary = useMemo(
    () => summarise(cells, photos.length, orientationAvailable),
    [cells, photos.length, orientationAvailable],
  );

  const capture = useCallback((source: 'camera' | 'upload' = 'camera') => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    if (photosRef.current.length >= maxPhotos) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const sharpness = verdict?.stats.sharpness ?? 0;
    const { sector, band } = orientationRef.current;

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const photo: CapturedPhoto = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          blob,
          url: URL.createObjectURL(blob),
          source,
          sharpness,
          sector,
          band,
        };
        setPhotos((prev) => [...prev, photo]);
      },
      'image/jpeg',
      0.92,
    );
    setFlash(true);
    window.setTimeout(() => setFlash(false), 120);
  }, [maxPhotos, verdict]);

  const startCamera = useCallback(async () => {
    setCameraState('starting');
    setCameraError('');
    setCameraSlow(false);
    // Some browsers never settle the getUserMedia promise (no answer to the
    // permission prompt, a camera held by another app). Don't strand the user.
    const slowTimer = window.setTimeout(() => setCameraSlow(true), 12_000);
    if (!navigator.mediaDevices?.getUserMedia) {
      window.clearTimeout(slowTimer);
      setCameraState('unavailable');
      setCameraError('This browser does not expose a camera API. You can still upload photos.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      window.clearTimeout(slowTimer);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraState('live');

      if (await OrientationTracker.requestPermission()) {
        const tracker = new OrientationTracker();
        tracker.start(({ heading, band }) => {
          if (heading === null) return;
          const next = { sector: sectorFor(heading), band };
          orientationRef.current = next;
          setOrientation(next);
          setOrientationAvailable(true);
        });
        trackerRef.current = tracker;
      }
    } catch (err) {
      window.clearTimeout(slowTimer);
      const error = err as DOMException;
      setCameraState(error.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      setCameraError(
        error.name === 'NotAllowedError'
          ? 'Camera permission was declined. You can grant it in the browser address bar, or upload photos instead.'
          : `Could not open the camera (${error.message}). You can still upload photos.`,
      );
    }
  }, []);

  useEffect(() => {
    void startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      trackerRef.current?.stop();
    };
  }, [startCamera]);

  // Quality analysis loop, ~5 Hz. Also drives auto-capture.
  useEffect(() => {
    if (cameraState !== 'live') return undefined;
    analyserRef.current ??= new FrameAnalyser();
    let timer = 0;

    const tick = () => {
      const video = videoRef.current;
      if (video && video.videoWidth) {
        const stats = analyserRef.current!.analyse(video, video.videoWidth, video.videoHeight);
        const next = judge(stats);
        setVerdict(next);

        if (autoRef.current && next.blocking.length === 0) {
          const now = Date.now();
          const { sector, band } = orientationRef.current;
          const covered = sector !== null && band !== null
            ? photosRef.current.some((p) => p.sector === sector && p.band === band)
            : false;
          const gap = sector === null ? 2500 : covered ? 4000 : 900;
          if (now - lastAutoShot.current > gap && photosRef.current.length < maxPhotos) {
            lastAutoShot.current = now;
            capture('camera');
          }
        }
      }
      timer = window.setTimeout(tick, 200);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [cameraState, capture, maxPhotos]);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(`Reading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
    const room = maxPhotos - photosRef.current.length;
    const chosen = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, room);
    const added: CapturedPhoto[] = [];
    for (const file of chosen) {
      let sharpness = 0;
      try {
        sharpness = (await analyseImageFile(file)).sharpness;
      } catch {
        /* unreadable files still go to the server, which reports on them */
      }
      added.push({
        id: `${file.name}_${file.size}_${Math.random().toString(36).slice(2, 8)}`,
        blob: file,
        url: URL.createObjectURL(file),
        source: 'upload',
        sharpness,
        sector: null,
        band: null,
      });
    }
    setPhotos((prev) => [...prev, ...added]);
    setBusy('');
  }, [maxPhotos]);

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
  };

  const blurryCount = photos.filter((p) => p.sharpness > 0 && p.sharpness < 12).length;
  const canFinish = photos.length >= MIN_PHOTOS;

  return (
    <div className="capture">
      <div className="capture__stage">
        <video ref={videoRef} className="capture__video" playsInline muted autoPlay />
        {flash && <div className="capture__flash" />}

        {cameraState !== 'live' && (
          <div className="capture__cameraFallback">
            {cameraState === 'starting' && !cameraSlow && <p>Requesting camera…</p>}
            {cameraState === 'starting' && cameraSlow && (
              <>
                <h3>The camera hasn’t answered</h3>
                <p>
                  Allow camera access when your browser asks, or close any other app
                  using the camera. You can upload photos instead — the Upload button
                  below works either way.
                </p>
                <button className="btn" onClick={() => void startCamera()}>Try again</button>
              </>
            )}
            {(cameraState === 'denied' || cameraState === 'unavailable') && (
              <>
                <h3>No camera feed</h3>
                <p>{cameraError}</p>
                <button className="btn" onClick={() => void startCamera()}>Try again</button>
              </>
            )}
          </div>
        )}

        <div className="capture__overlay">
          <div className="capture__topbar">
            <button className="chip chip--ghost" onClick={onCancel}>Cancel</button>
            <span className="chip">{photos.length}/{maxPhotos} photos</span>
          </div>

          <div className="capture__reticle" aria-hidden />

          <div className="capture__warnings">
            {verdict?.warnings.map((warning) => (
              <span key={warning} className="chip chip--warn">{warning}</span>
            ))}
            {verdict && verdict.warnings.length === 0 && cameraState === 'live' && (
              <span className="chip chip--good">Looks good</span>
            )}
          </div>

          <div className="capture__guide">
            <CoverageDial
              cells={cells}
              currentSector={orientation.sector}
              available={orientationAvailable}
              sectors={AZIMUTH_SECTORS}
            />
            <div className="capture__guideText">
              <p className="capture__advice">{summary.advice}</p>
              {!orientationAvailable && (
                <p className="capture__note">
                  This device doesn’t report camera direction, so angles aren’t tracked —
                  the count is all we can honestly show.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="capture__controls">
        <label className="btn btn--ghost">
          {cameraState === 'live' ? 'Upload' : 'Add photos'}
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
          />
        </label>

        <button
          className="shutter"
          onClick={() => capture('camera')}
          disabled={cameraState !== 'live' || photos.length >= maxPhotos}
          aria-label="Take photo"
        >
          <span className="shutter__inner" />
        </button>

        <button
          className={`btn btn--ghost ${auto ? 'btn--on' : ''}`}
          onClick={() => setAuto((v) => !v)}
          disabled={cameraState !== 'live'}
        >
          Auto {auto ? 'on' : 'off'}
        </button>
      </div>

      {busy && <p className="capture__busy">{busy}</p>}

      {photos.length > 0 && (
        <div className="tray">
          <div className="tray__strip">
            {photos.map((photo) => (
              <div key={photo.id} className="tray__item">
                <img src={photo.url} alt="" />
                {photo.sharpness > 0 && photo.sharpness < 12 && <span className="tray__flag">blurry</span>}
                <button className="tray__remove" onClick={() => removePhoto(photo.id)} aria-label="Remove">×</button>
              </div>
            ))}
          </div>
          {blurryCount > 0 && (
            <p className="capture__note">
              {blurryCount} photo{blurryCount === 1 ? ' looks' : 's look'} blurry — the server will
              drop the worst of them automatically.
            </p>
          )}
        </div>
      )}

      <div className="capture__finish">
        <button className="btn btn--primary" disabled={!canFinish} onClick={() => onFinish(photos)}>
          {canFinish
            ? `Reconstruct from ${photos.length} photos`
            : `Need ${MIN_PHOTOS - photos.length} more photo${MIN_PHOTOS - photos.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
