import { butterworthHighpass, FilterBank, RingBuffer } from "eegkit";
import { useEffect, useState } from "react";
import type { EEGState } from "./use-eeg";

/** Options for {@link useTrace}. */
export interface UseTraceOptions {
  /** Seconds of history to keep. Default 5. */
  readonly seconds?: number;
  /** Maximum re-renders per second. Default 30. */
  readonly fps?: number;
  /**
   * High-pass cutoff in Hz applied for display, so electrode drift doesn't
   * push the trace off screen, or `false` for raw data. Default 1.
   */
  readonly highpass?: number | false;
}

/** What {@link useTrace} returns. */
export interface Trace {
  /** One array per channel, oldest sample first. Fills up to `seconds × sampleRate`. */
  readonly data: readonly Float64Array[];
  /** Increments on every update; handy as a memo key for drawing. */
  readonly version: number;
}

const EMPTY: Trace = { data: [], version: 0 };

/**
 * A scrolling window of recent samples per channel, for drawing live traces.
 * Samples are buffered outside React; the component re-renders at most
 * `fps` times per second, and only when new data arrived.
 *
 * @example
 * ```tsx
 * const { data } = useTrace(eeg, { seconds: 4 });
 * return data.map((samples, i) => <Sparkline key={i} values={samples} />);
 * ```
 */
export function useTrace(eeg: EEGState, options: UseTraceOptions = {}): Trace {
  const { seconds = 5, fps = 30, highpass = 1 } = options;
  const { sampleRate, labels, session, subscribeFrames } = eeg;
  const channels = labels.length;
  const [trace, setTrace] = useState<Trace>(EMPTY);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is a trigger: buffers restart on every reconnection.
  useEffect(() => {
    setTrace(EMPTY);
    if (sampleRate <= 0 || channels === 0) return;
    const capacity = Math.max(1, Math.round(seconds * sampleRate));
    const rings = Array.from({ length: channels }, () => new RingBuffer(capacity));
    const bank =
      highpass && highpass < sampleRate / 2
        ? new FilterBank(butterworthHighpass(2, highpass, sampleRate), channels)
        : undefined;
    const filtered = new Float64Array(channels);
    let primed = false;
    let dirty = false;
    let version = 0;

    const unsubscribe = subscribeFrames((frame) => {
      let values = frame;
      if (bank) {
        if (!primed) {
          bank.prime(frame);
          primed = true;
        }
        values = bank.processFrame(frame, filtered);
      }
      for (let c = 0; c < channels; c++) (rings[c] as RingBuffer).push(values[c] as number);
      dirty = true;
    });
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      version += 1;
      setTrace({ data: rings.map((ring) => ring.toArray()), version });
    }, 1000 / Math.max(1, fps));
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [subscribeFrames, sampleRate, channels, seconds, fps, highpass, session]);

  return trace;
}
