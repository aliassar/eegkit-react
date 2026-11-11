import { act, renderHook } from "@testing-library/react";
import { createSyntheticEEG, type PipelineResult } from "eegkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EEGSource,
  manualSource,
  selectBandPowers,
  syntheticSource,
  useBandPowers,
  useEEG,
  useNeurofeedback,
  useTrace,
  webSocketSource,
} from "../src/index";

const FS = 256;

function feed(source: ReturnType<typeof manualSource>, seconds: number, seed = 1, alpha = 10) {
  const eeg = createSyntheticEEG({
    sampleRate: FS,
    channels: source.channels.length,
    seed,
    bands: { alpha },
  });
  act(() => source.pushChunk(eeg.next(Math.round(seconds * FS))));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useEEG", () => {
  it("connects, analyses and reports status", () => {
    const source = manualSource({ sampleRate: FS, channels: ["O1", "O2"] });
    const { result, unmount } = renderHook(() => useEEG(source, { notch: 50 }));
    expect(result.current.status).toBe("open");
    expect(result.current.labels).toEqual(["O1", "O2"]);
    expect(result.current.resultsPerSecond).toBe(4);
    expect(result.current.result).toBeUndefined();

    feed(source, 3, 1, 25);
    const latest = result.current.result;
    expect(latest?.channels.map((c) => c.label)).toEqual(["O1", "O2"]);
    expect(latest?.channels[0]?.peakAlpha).toBeGreaterThan(8);
    expect(latest?.channels[0]?.peakAlpha).toBeLessThan(13);

    unmount();
    // Disconnected: pushes go nowhere and don't throw.
    expect(() => source.push([1, 2])).not.toThrow();
  });

  it("stays idle without a source", () => {
    const { result } = renderHook(() => useEEG(null));
    expect(result.current.status).toBe("idle");
    expect(result.current.sampleRate).toBe(0);
  });

  it("counts every result even when several arrive in one tick", () => {
    const source = manualSource({ sampleRate: FS, channels: 1 });
    const seen: PipelineResult[] = [];
    const { result } = renderHook(() => useEEG(source));
    act(() => {
      result.current.subscribeResults((r) => seen.push(r));
    });
    feed(source, 4);
    // 2 s windows every 0.25 s over 4 s of data.
    expect(seen).toHaveLength(9);
    expect(result.current.result?.index).toBe(8);
  });

  it("reports a channel mismatch once instead of throwing", () => {
    const source = manualSource({ sampleRate: FS, channels: 2 });
    const { result } = renderHook(() => useEEG(source));
    act(() => {
      source.push([1, 2, 3]);
      source.push([1, 2, 3]);
    });
    expect(result.current.error).toBeInstanceOf(RangeError);
  });

  it("reports invalid options as an error state", () => {
    const source = manualSource({ sampleRate: FS, channels: 1 });
    const { result } = renderHook(() => useEEG(source, { windowSeconds: 0 }));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(RangeError);
  });

  it("reconnects when the source changes and when options change by value", () => {
    const connect = vi.fn(() => () => {});
    const make = (): EEGSource => ({ sampleRate: FS, channels: ["a"], connect });
    const first = make();
    const { rerender, result } = renderHook(
      ({ source, notch }: { source: EEGSource; notch: 50 | 60 }) => useEEG(source, { notch }),
      { initialProps: { source: first, notch: 50 } },
    );
    const session = result.current.session;
    rerender({ source: first, notch: 50 }); // new options object, same value
    expect(connect).toHaveBeenCalledTimes(1);
    rerender({ source: first, notch: 60 });
    expect(connect).toHaveBeenCalledTimes(2);
    rerender({ source: make(), notch: 60 });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(result.current.session).toBe(session + 2);
  });

  it("reset clears the latest result", () => {
    const source = manualSource({ sampleRate: FS, channels: 1 });
    const { result } = renderHook(() => useEEG(source));
    feed(source, 2.5);
    expect(result.current.result).toBeDefined();
    act(() => result.current.reset());
    expect(result.current.result).toBeUndefined();
  });
});

describe("useBandPowers", () => {
  it("averages channels or picks one by index or label", () => {
    const source = manualSource({ sampleRate: FS, channels: ["L", "R"] });
    const { result } = renderHook(() => {
      const eeg = useEEG(source);
      return {
        eeg,
        average: useBandPowers(eeg),
        right: useBandPowers(eeg, { channel: "R", relative: false }),
      };
    });
    expect(result.current.average).toBeUndefined();
    feed(source, 2);
    const latest = result.current.eeg.result;
    const left = latest?.channels[0]?.relativeBandPower.alpha ?? 0;
    const right = latest?.channels[1]?.relativeBandPower.alpha ?? 0;
    expect(result.current.average?.alpha).toBeCloseTo((left + right) / 2, 12);
    expect(result.current.right).toBe(latest?.channels[1]?.bandPower);
    expect(selectBandPowers(latest, { channel: 5 })).toBeUndefined();
    expect(selectBandPowers(latest, { channel: "nope" })).toBeUndefined();
  });
});

describe("useTrace", () => {
  it("keeps the last N seconds and throttles re-renders", () => {
    vi.useFakeTimers();
    const source = manualSource({ sampleRate: FS, channels: 2 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      const eeg = useEEG(source);
      return useTrace(eeg, { seconds: 1, fps: 10 });
    });
    expect(result.current.data).toEqual([]);
    feed(source, 3);
    const before = renders;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Data arrived once, so only one trace update despite ten timer ticks.
    expect(result.current.version).toBe(1);
    expect(renders - before).toBeLessThanOrEqual(2);
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data[0]).toHaveLength(FS);
    // High-passed for display: centred on zero despite any offset.
    const mean = (result.current.data[0] as Float64Array).reduce((a, b) => a + b, 0) / FS;
    expect(Math.abs(mean)).toBeLessThan(5);
  });
});

describe("useNeurofeedback", () => {
  it("records a baseline, then rewards an increase", () => {
    const source = manualSource({ sampleRate: FS, channels: 1 });
    const { result } = renderHook(() => {
      const eeg = useEEG(source);
      return useNeurofeedback(eeg, {
        metric: (r) => r.channels[0]?.relativeBandPower.alpha ?? Number.NaN,
        baselineSeconds: 5,
        timeConstant: 0.5,
      });
    });
    expect(result.current.phase).toBe("idle");
    feed(source, 4, 1, 6);
    expect(result.current.phase).toBe("baseline");
    expect(result.current.progress).toBeGreaterThan(0);
    expect(result.current.progress).toBeLessThan(1);
    feed(source, 6, 2, 6);
    expect(result.current.phase).toBe("training");
    const atBaseline = result.current.score;
    feed(source, 6, 3, 30); // much stronger alpha
    expect(result.current.z).toBeGreaterThan(2);
    expect(result.current.score).toBeGreaterThan(atBaseline);
    expect(result.current.score).toBeLessThanOrEqual(1);

    act(() => result.current.restart());
    expect(result.current.phase).toBe("idle");
  });

  it("flips the sign for direction down", () => {
    const source = manualSource({ sampleRate: FS, channels: 1 });
    const { result } = renderHook(() => {
      const eeg = useEEG(source);
      return useNeurofeedback(eeg, {
        metric: (r) => r.channels[0]?.relativeBandPower.alpha ?? Number.NaN,
        direction: "down",
        baselineSeconds: 5,
        timeConstant: 0.5,
      });
    });
    feed(source, 10, 1, 6);
    feed(source, 6, 3, 30);
    expect(result.current.z).toBeLessThan(-2);
    expect(result.current.score).toBeLessThan(0.2);
  });
});

describe("sources", () => {
  it("syntheticSource streams in real time", () => {
    vi.useFakeTimers();
    const source = syntheticSource({ sampleRate: FS, channels: 3, seed: 1 });
    expect(source.channels).toEqual(["ch1", "ch2", "ch3"]);
    const { result, unmount } = renderHook(() => useEEG(source));
    expect(result.current.status).toBe("open");
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.result?.channels).toHaveLength(3);
    unmount();
  });

  it("webSocketSource reports connection state", () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      binaryType = "blob";
      onopen: ((e: never) => unknown) | null = null;
      onmessage: ((e: never) => unknown) | null = null;
      onerror: ((e: never) => unknown) | null = null;
      onclose: ((e: never) => unknown) | null = null;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      close() {}
    }
    const source = webSocketSource("ws://test", {
      sampleRate: FS,
      channels: 2,
      reconnect: false,
      WebSocket: FakeSocket,
    });
    const { result } = renderHook(() => useEEG(source));
    expect(result.current.status).toBe("connecting");
    const socket = sockets[0] as FakeSocket;
    act(() => (socket.onopen as (e: unknown) => void)({}));
    expect(result.current.status).toBe("open");
    const frames = Array.from({ length: 2 * FS }, (_, i) => [Math.sin(i), Math.cos(i)]);
    act(() => (socket.onmessage as (e: unknown) => void)({ data: JSON.stringify(frames) }));
    expect(result.current.result?.channels).toHaveLength(2);
    act(() => (socket.onclose as (e: unknown) => void)({ code: 1000, reason: "" }));
    expect(result.current.status).toBe("closed");
  });

  it("validates its arguments", () => {
    expect(() => manualSource({ sampleRate: 0, channels: 1 })).toThrow(RangeError);
    expect(() => manualSource({ sampleRate: FS, channels: [] })).toThrow(RangeError);
    expect(() => syntheticSource({ sampleRate: FS, channels: 1.5 })).toThrow(RangeError);
    expect(() => manualSource({ sampleRate: FS, channels: 2 }).pushChunk([[1]])).toThrow(
      RangeError,
    );
  });
});
