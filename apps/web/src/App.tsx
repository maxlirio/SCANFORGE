import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthResponse, JobOptions, JobRecord } from '@scanforge/shared';
import { api } from './lib/api';
import { Landing } from './components/Landing';
import { CaptureView, type CapturedPhoto } from './components/CaptureView';
import { ProcessingView } from './components/ProcessingView';
import { ResultView } from './components/ResultView';
import { DesktopHome, type ChosenPhoto } from './components/DesktopHome';
import { IS_DESKTOP } from './lib/desktop';

type Screen = 'landing' | 'home' | 'capture' | 'processing' | 'result';

const DEFAULT_OPTIONS: JobOptions = {
  provider: 'colmap-local',
  quality: 'balanced',
  mode: 'object',
  matcher: 'auto',
};

export default function App() {
  const [screen, setScreen] = useState<Screen>(IS_DESKTOP ? 'home' : 'landing');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState('');
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const [recent, setRecent] = useState<Omit<JobRecord, 'logs'>[]>([]);
  const [fatal, setFatal] = useState('');
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const selectedProvider = health?.providers.find((p) => p.id === options.provider);

  // Health decides which providers the landing page can offer.
  useEffect(() => {
    api.health()
      .then((h) => {
        setHealth(h);
        setOptions((prev) => ({
          ...prev,
          provider: h.defaultProvider || prev.provider,
          quality: h.defaultQuality ?? prev.quality,
        }));
      })
      .catch((err: Error) => setHealthError(`Cannot reach the server: ${err.message}`));
    api.listJobs().then(setRecent).catch(() => undefined);
  }, []);

  // Deep link: /#<jobId> reopens a scan, which is how you get back to a scan
  // started on a phone from a laptop (and after a reload).
  useEffect(() => {
    const id = location.hash.replace('#', '').trim();
    // #capture jumps straight to the camera (handy for testing on a device);
    // any other hash is a scan id to reopen.
    if (id === 'capture') setScreen('capture');
    else if (id) void openJob(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchJob = useCallback((id: string) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = api.streamJob(id, (next) => {
      setJob(next);
      if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled') {
        api.listJobs().then(setRecent).catch(() => undefined);
      }
    }, () => {
      // SSE dropped (server restart, phone slept): fall back to a poll.
      void api.getJob(id).then(setJob).catch(() => undefined);
    });
  }, []);

  const openJob = useCallback(async (id: string) => {
    try {
      const record = await api.getJob(id);
      setJob(record);
      location.hash = id;
      if (record.status === 'succeeded') {
        setScreen('result');
      } else {
        setScreen('processing');
        watchJob(id);
      }
    } catch (err) {
      setFatal((err as Error).message);
    }
  }, [watchJob]);

  useEffect(() => () => unsubscribeRef.current?.(), []);

  const handleFinishCapture = useCallback(async (photos: CapturedPhoto[]) => {
    setFatal('');
    setScreen('processing');
    setUploadProgress({ sent: 0, total: photos.length });
    try {
      const created = await api.createJob(options);
      setJob({ ...created, imageCount: photos.length });
      location.hash = created.id;
      await api.uploadPhotos(created.id, photos.map((p) => p.blob), (sent, total) =>
        setUploadProgress({ sent, total }));
      setUploadProgress(null);
      const started = await api.startJob(created.id);
      setJob(started);
      watchJob(created.id);
      photos.forEach((p) => URL.revokeObjectURL(p.url));
    } catch (err) {
      setUploadProgress(null);
      setFatal((err as Error).message);
    }
  }, [options, watchJob]);

  const handleGenerate = useCallback((photos: ChosenPhoto[]) => {
    void handleFinishCapture(photos.map((p) => ({
      id: p.id, blob: p.file, url: p.url, source: 'upload' as const,
      sharpness: p.sharpness, sector: null, band: null,
    })));
  }, [handleFinishCapture]);

  const startNewScan = () => {
    unsubscribeRef.current?.();
    setJob(null);
    setFatal('');
    location.hash = '';
    setScreen(IS_DESKTOP ? 'home' : 'capture');
  };

  return (
    <div className="app">
      {fatal && (
        <div className="callout callout--error app__fatal">
          {fatal}
          <button className="linkbtn" onClick={() => setFatal('')}>dismiss</button>
        </div>
      )}

      {screen === 'home' && (
        <DesktopHome
          health={health}
          healthError={healthError}
          options={options}
          onOptions={setOptions}
          onGenerate={handleGenerate}
          recent={recent}
          onOpen={(id) => void openJob(id)}
        />
      )}

      {screen === 'landing' && (
        <Landing
          health={health}
          healthError={healthError}
          options={options}
          onOptions={setOptions}
          onStart={() => setScreen('capture')}
          recent={recent}
          onOpen={(id) => void openJob(id)}
        />
      )}


      {screen === 'capture' && (
        <CaptureView
          maxPhotos={health?.maxImages ?? 120}
          minPhotos={selectedProvider?.minPhotos ?? 8}
          singleShot={(selectedProvider?.minPhotos ?? 8) <= 1}
          onCancel={() => setScreen('landing')}
          onFinish={(photos) => void handleFinishCapture(photos)}
        />
      )}

      {screen === 'processing' && job && (
        <ProcessingView
          job={job}
          uploadProgress={uploadProgress}
          onCancel={() => void api.cancelJob(job.id)}
          onRetry={startNewScan}
          onView={() => setScreen('result')}
        />
      )}

      {screen === 'result' && job && (
        <ResultView job={job} onNewScan={startNewScan} />
      )}
    </div>
  );
}
