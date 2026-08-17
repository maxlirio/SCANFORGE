import { useEffect, useRef, useState } from 'react';
import type { EngineEvent, EngineState, EngineStepId } from '@scanforge/shared';
import { ENGINE_STEP_LABELS, ENGINE_STEP_ORDER } from '@scanforge/shared';
import { api } from '../lib/api';

interface Props {
  onReady(): void;
}

type StepStatus = 'pending' | 'active' | 'done';

/**
 * First-run setup. The app has no 3D engine until this runs: it downloads a
 * Python runtime if needed, the engine source, PyTorch and ~16 GB of model
 * weights. Progress is whatever the underlying tool actually reports — a real
 * fraction for downloads, an indeterminate bar for pip.
 */
export function EngineSetup({ onReady }: Props) {
  const [state, setState] = useState<EngineState | null>(null);
  const [steps, setSteps] = useState<Record<EngineStepId, StepStatus>>(() =>
    Object.fromEntries(ENGINE_STEP_ORDER.map((s) => [s, 'pending'])) as Record<EngineStepId, StepStatus>);
  const [current, setCurrent] = useState<{ message: string; progress: number | null } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void api.engineState().then(setState).catch(() => undefined);
    const close = api.streamEngine((event: EngineEvent) => {
      if (event.type === 'state') {
        setState(event.state);
        if (event.state.error) setError(event.state.error);
      } else if (event.type === 'step') {
        setSteps((prev) => {
          const next = { ...prev };
          const index = ENGINE_STEP_ORDER.indexOf(event.step);
          ENGINE_STEP_ORDER.slice(0, index).forEach((s) => { next[s] = 'done'; });
          next[event.step] = event.status === 'end' ? 'done' : 'active';
          return next;
        });
        setCurrent({ message: event.message ?? '', progress: event.progress ?? null });
      } else if (event.type === 'log') {
        setLog((prev) => [...prev.slice(-300), event.message]);
      } else if (event.type === 'done') {
        onReady();
      } else if (event.type === 'error') {
        setError(event.message ?? 'Setup failed.');
      }
    });
    return close;
  }, [onReady]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length, showLog]);

  const start = async () => {
    setError('');
    await api.installEngine();
    setState((prev) => (prev ? { ...prev, installing: true } : prev));
  };

  const installing = state?.installing ?? false;

  return (
    <div className="setup">
      <header className="desktop__bar">
        <h1>SCANFORGE</h1>
      </header>

      <div className="setup__card">
        <h2>One-time setup</h2>
        <p className="setup__lede">
          SCANFORGE generates 3D models on this Mac’s GPU. The engine that does it
          isn’t bundled with the app — it’s about{' '}
          <strong>{state?.downloadEstimateGb ?? 18} GB</strong> of program and model
          weights. This downloads it once.
        </p>

        {!installing && !error && (
          <>
            <ul className="setup__facts">
              <li>Downloads once; later launches start straight up</li>
              <li>Needs about 20 GB of free disk space</li>
              <li>Takes 20–40 minutes on a typical connection</li>
              <li>No account or sign-in required</li>
            </ul>
            <button className="btn btn--primary btn--large" onClick={() => void start()}>
              Install the 3D engine
            </button>
          </>
        )}

        {(installing || error) && (
          <ol className="setup__steps">
            {ENGINE_STEP_ORDER.map((step) => (
              <li key={step} className={`setup__step setup__step--${steps[step]}`}>
                <span className="setup__stepDot" aria-hidden />
                <span className="setup__stepName">{ENGINE_STEP_LABELS[step]}</span>
                {steps[step] === 'active' && current && (
                  <span className="setup__stepMsg">{current.message}</span>
                )}
              </li>
            ))}
          </ol>
        )}

        {installing && current && (
          current.progress === null ? (
            <div className="bar bar--indeterminate"><div className="bar__pulse" /></div>
          ) : (
            <div className="bar">
              <div className="bar__fill" style={{ width: `${current.progress * 100}%` }} />
            </div>
          )
        )}

        {error && (
          <div className="callout callout--error">
            <strong>Setup stopped</strong>
            <p>{error}</p>
            <button className="btn" onClick={() => void start()}>Try again</button>
            <p className="fineprint">
              It resumes where it left off — nothing already downloaded is fetched twice.
            </p>
          </div>
        )}

        <p className="fineprint">{state?.licenceNote}</p>

        <button className="linkbtn" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide' : 'Show'} details
        </button>
        {showLog && (
          <pre className="log log--compact" ref={logRef}>
            {log.join('\n') || 'Nothing yet.'}
          </pre>
        )}
      </div>
    </div>
  );
}
