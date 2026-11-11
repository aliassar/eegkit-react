import { Baseline, ExponentialSmoother, type PipelineResult } from "eegkit";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EEGState } from "./use-eeg";

/** Options for {@link useNeurofeedback}. */
export interface NeurofeedbackOptions {
  /**
   * The value being trained, from each analysis window, e.g.
   * `(r) => r.channels[0].relativeBandPower.alpha`. Non-finite values are skipped.
   * Read when each result arrives, so an inline function is fine.
   */
  readonly metric: (result: PipelineResult) => number;
  /** Which direction is rewarded. Default `"up"`. */
  readonly direction?: "up" | "down";
  /** Length of the resting baseline recorded before training, in seconds. Default 30. */
  readonly baselineSeconds?: number;
  /** Smoothing time constant in seconds. Default 2. */
  readonly timeConstant?: number;
}

/** What {@link useNeurofeedback} returns. */
export interface NeurofeedbackState {
  /** `"baseline"` while recording the reference, then `"training"`. `"idle"` before any data. */
  readonly phase: "idle" | "baseline" | "training";
  /** Baseline progress, 0 to 1. */
  readonly progress: number;
  /** Latest smoothed metric. */
  readonly value: number;
  /** Smoothed metric as a z-score against the baseline, sign-flipped for `direction: "down"`. */
  readonly z: number;
  /** Reward from 0 to 1: a logistic of `z`, so 0.5 is "same as baseline". */
  readonly score: number;
  /** Record a new baseline. */
  readonly restart: () => void;
}

interface Snapshot {
  readonly phase: NeurofeedbackState["phase"];
  readonly progress: number;
  readonly value: number;
  readonly z: number;
}

const IDLE: Snapshot = { phase: "idle", progress: 0, value: Number.NaN, z: 0 };

/**
 * A complete neurofeedback loop on top of {@link useEEG}: record a resting
 * baseline, then turn the live, smoothed metric into a 0–1 reward relative
 * to that baseline. Drive any feedback with `score`: brightness, volume, a
 * game's speed.
 *
 * Every analysis window is counted, even when several arrive in one render.
 *
 * @example
 * ```tsx
 * const nf = useNeurofeedback(eeg, {
 *   metric: (r) => thetaBetaRatio(r.channels[0].bandPower),
 *   direction: "down",
 * });
 * <Circle opacity={nf.phase === "training" ? nf.score : 0.2} />
 * ```
 */
export function useNeurofeedback(eeg: EEGState, options: NeurofeedbackOptions): NeurofeedbackState {
  const { direction = "up", baselineSeconds = 30, timeConstant = 2 } = options;
  const { subscribeResults, resultsPerSecond, session } = eeg;
  const metricRef = useRef(options.metric);
  metricRef.current = options.metric;
  const [snapshot, setSnapshot] = useState<Snapshot>(IDLE);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` and `generation` are triggers: the baseline restarts on reconnection or `restart()`.
  useEffect(() => {
    setSnapshot(IDLE);
    if (!(resultsPerSecond > 0)) return;
    const needed = Math.max(2, Math.ceil(baselineSeconds * resultsPerSecond));
    const smoother = new ExponentialSmoother({ timeConstant, rate: resultsPerSecond });
    const baseline = new Baseline({ minSamples: needed });
    const sign = direction === "down" ? -1 : 1;

    return subscribeResults((result) => {
      const raw = metricRef.current(result);
      if (!Number.isFinite(raw)) return;
      const value = smoother.update(raw);
      if (baseline.count < needed) {
        baseline.add(value);
        setSnapshot({ phase: "baseline", progress: baseline.count / needed, value, z: 0 });
        return;
      }
      const z = sign * baseline.zScore(value);
      setSnapshot({ phase: "training", progress: 1, value, z: Number.isFinite(z) ? z : 0 });
    });
  }, [
    subscribeResults,
    resultsPerSecond,
    baselineSeconds,
    timeConstant,
    direction,
    session,
    generation,
  ]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...snapshot, score: 1 / (1 + Math.exp(-snapshot.z)), restart };
}
