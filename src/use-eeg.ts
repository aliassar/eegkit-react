import { createPipeline, type Frame, type PipelineOptions, type PipelineResult } from "eegkit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EEGSource, SourceStatus } from "./sources";

/** Pipeline settings for {@link useEEG}. Rate and channels come from the source. */
export type UseEEGOptions = Omit<PipelineOptions, "sampleRate" | "channels">;

type Listener<T> = (value: T) => void;

/** What {@link useEEG} returns. Pass it to the other hooks. */
export interface EEGState {
  readonly status: SourceStatus;
  /** The last connection or data error, cleared when a new connection opens. */
  readonly error: unknown;
  /** The latest analysis window (band powers, spectrum, quality per channel). */
  readonly result: PipelineResult | undefined;
  readonly sampleRate: number;
  readonly labels: readonly string[];
  /** Analysis results per second (1 / `stepSeconds`). */
  readonly resultsPerSecond: number;
  /** Increments on every (re)connection, so dependent state can reset. */
  readonly session: number;
  /** Raw frames as they arrive, outside React's render cycle. Returns an unsubscribe function. */
  readonly subscribeFrames: (listener: Listener<Frame>) => () => void;
  /** Every analysis result, even several in one tick. Returns an unsubscribe function. */
  readonly subscribeResults: (listener: Listener<PipelineResult>) => () => void;
  /** Clear filter state and buffered data, e.g. after adjusting an electrode. */
  readonly reset: () => void;
}

/**
 * Connects to an EEG source and runs eegkit's real-time pipeline on it:
 * band-pass and notch filters, a sliding window, Welch spectrum, band powers,
 * peak alpha and signal quality, re-rendering a few times per second.
 *
 * Reconnects when `source` changes identity, so create it with `useMemo`
 * (or outside the component). Options are compared by value. Pass `null`
 * to stay disconnected.
 *
 * @example
 * ```tsx
 * const source = useMemo(() => syntheticSource({ sampleRate: 256, channels: 4 }), []);
 * const eeg = useEEG(source, { notch: 50 });
 * return <Text>{eeg.result?.channels[0].relativeBandPower.alpha}</Text>;
 * ```
 */
export function useEEG(
  source: EEGSource | null | undefined,
  options: UseEEGOptions = {},
): EEGState {
  const [status, setStatus] = useState<SourceStatus>("idle");
  const [error, setError] = useState<unknown>(undefined);
  const [result, setResult] = useState<PipelineResult | undefined>(undefined);
  const [session, setSession] = useState(0);

  const frameListeners = useRef(new Set<Listener<Frame>>()).current;
  const resultListeners = useRef(new Set<Listener<PipelineResult>>()).current;
  const resetRef = useRef<() => void>(() => {});

  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!source) {
      setStatus("idle");
      setResult(undefined);
      return;
    }
    let pipeline: ReturnType<typeof createPipeline>;
    try {
      pipeline = createPipeline({
        ...(JSON.parse(optionsKey) as UseEEGOptions),
        sampleRate: source.sampleRate,
        channels: source.channels,
      });
    } catch (e) {
      // Invalid options (e.g. a window shorter than one sample) shouldn't crash the tree.
      setStatus("error");
      setError(e);
      return;
    }
    let lastErrorMessage = "";
    const report = (e: unknown) => {
      // A misconfigured stream fails on every frame; report it once.
      const message = e instanceof Error ? e.message : String(e);
      if (message !== lastErrorMessage) {
        lastErrorMessage = message;
        setError(e);
      }
    };

    const unsubscribe = pipeline.subscribe((r) => {
      setResult(r);
      for (const listener of resultListeners) listener(r);
    });
    resetRef.current = () => {
      pipeline.reset();
      setResult(undefined);
    };
    setResult(undefined);
    setError(undefined);
    setSession((s) => s + 1);

    const disconnect = source.connect({
      onFrame(frame) {
        try {
          pipeline.push(frame);
        } catch (e) {
          report(e);
          return;
        }
        for (const listener of frameListeners) listener(frame);
      },
      onStatus(next) {
        setStatus(next);
        if (next === "open") lastErrorMessage = "";
      },
      onError: report,
    });

    return () => {
      disconnect();
      unsubscribe();
      resetRef.current = () => {};
    };
  }, [source, optionsKey, frameListeners, resultListeners]);

  const subscribeFrames = useCallback(
    (listener: Listener<Frame>) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    [frameListeners],
  );
  const subscribeResults = useCallback(
    (listener: Listener<PipelineResult>) => {
      resultListeners.add(listener);
      return () => {
        resultListeners.delete(listener);
      };
    },
    [resultListeners],
  );
  const reset = useCallback(() => resetRef.current(), []);

  return {
    status,
    error,
    result,
    sampleRate: source?.sampleRate ?? 0,
    labels: source?.channels ?? [],
    // The pipeline rounds its step to whole samples; report the true rate.
    resultsPerSecond: source
      ? source.sampleRate /
        Math.max(1, Math.round((options.stepSeconds ?? 0.25) * source.sampleRate))
      : 0,
    session,
    subscribeFrames,
    subscribeResults,
    reset,
  };
}
