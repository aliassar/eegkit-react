# eegkit-react

[![ci](https://github.com/aliassar/eegkit-react/actions/workflows/ci.yml/badge.svg)](https://github.com/aliassar/eegkit-react/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/eegkit-react)](https://www.npmjs.com/package/eegkit-react)
[![license](https://img.shields.io/github/license/aliassar/eegkit-react)](LICENSE)

React and React Native hooks for live EEG. Connect a source and you get band powers, signal
quality, scrolling traces and a ready-made neurofeedback loop. Built on
[eegkit](https://github.com/aliassar/eegkit).

The hooks are plain React with no DOM, so the same code runs on web, iOS and Android (Expo
included).

```sh
npm install eegkit eegkit-react
```

## Quick start

```tsx
import { useMemo } from "react";
import { syntheticSource, useBandPowers, useEEG } from "eegkit-react";

export function AlphaMeter() {
  // Swap in webSocketSource(...) or manualSource(...) for real data.
  const source = useMemo(() => syntheticSource({ sampleRate: 256, channels: 4 }), []);
  const eeg = useEEG(source, { notch: 50 });
  const powers = useBandPowers(eeg); // relative, averaged across channels

  if (!powers) return <p>Collecting the first 2 seconds…</p>;
  return <progress value={powers.alpha} max={1} />;
}
```

## Hooks

| Hook                                                                             | Returns                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useEEG(source, options?)`                                                       | `status`, `error`, `result` (latest analysis window), `labels`, `reset()`, plus subscriptions for the other hooks. Its `options` are eegkit's `createPipeline` options: `bandpass`, `notch`, `windowSeconds`, `stepSeconds`, `bands`, `quality`, … |
| `useBandPowers(eeg, { relative?, channel? })`                                    | Band powers for one channel (by index or label) or averaged across channels                                                                                                                                                                        |
| `useTrace(eeg, { seconds?, fps?, highpass? })`                                   | The last _n_ seconds per channel, for drawing. Throttled to `fps`. High-passed for display by default                                                                                                                                              |
| `useNeurofeedback(eeg, { metric, direction?, baselineSeconds?, timeConstant? })` | `phase` (baseline → training), `progress`, `value`, `z`, `score` (0–1), `restart()`                                                                                                                                                                |

Each `result` holds every channel's `bandPower`, `relativeBandPower`, `peakAlpha`, `spectrum`
and `quality` (`good` / `fair` / `poor`, with the reasons). A new one arrives 4 times a second
by default.

How rendering is kept cheap:

- Samples are processed outside React. Components re-render only when a new analysis window
  completes, or at the trace's frame rate.
- `useEEG` reconnects when the source object changes, so create the source with `useMemo`. Its
  options are compared by value, so inline objects are fine.
- `useNeurofeedback` counts every window, even when a large network message completes several
  windows in one render.

## Sources

```ts
// Realistic synthetic EEG with tunable bands, mains hum, blinks and drift.
syntheticSource({ sampleRate: 256, channels: ["AF7", "AF8"], bands: { alpha: 15 }, blinkRate: 10 });

// Any WebSocket server sending numbers: JSON arrays, { data: [...] }, or CSV lines.
webSocketSource("ws://192.168.1.20:8765", { sampleRate: 250, channels: 8 });

// Anything else: Web Bluetooth, Web Serial, a native module, a file player.
const source = manualSource({ sampleRate: 250, channels: 8 });
device.onSamples((frame) => source.push(frame));
```

To support another device, implement `EEGSource` yourself. It needs a `sampleRate`, the
channel labels, and a `connect(handlers)` method that returns a disconnect function.

## A neurofeedback screen in 20 lines

```tsx
import { thetaBetaRatio } from "eegkit";
import { useEEG, useNeurofeedback, webSocketSource } from "eegkit-react";

const source = webSocketSource("ws://localhost:8765", { sampleRate: 256, channels: ["Cz"] });

export function FocusTrainer() {
  const eeg = useEEG(source, { notch: 50 });
  const nf = useNeurofeedback(eeg, {
    metric: (r) => thetaBetaRatio(r.channels[0].bandPower),
    direction: "down", // a lower theta/beta ratio is rewarded
    baselineSeconds: 60,
  });

  if (eeg.status !== "open") return <p>Connecting… ({eeg.status})</p>;
  if (nf.phase !== "training") {
    return <p>Relax with your eyes open. Baseline {Math.round(nf.progress * 100)}%</p>;
  }
  return <div style={{ opacity: 0.2 + 0.8 * nf.score, background: "teal", height: 200 }} />;
}
```

For a complete app with traces, quality indicators and sessions, see
[eegkit-neurofeedback](https://github.com/aliassar/eegkit-neurofeedback), an Expo app for web,
iOS and Android.

## Not medical software

This package is for research, education, wellness and hobby projects. It isn't a medical device.

## License

[MIT](LICENSE) © Ali Assar
