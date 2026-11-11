import {
  type Chunk,
  connectWebSocket,
  type Frame,
  type MessageParser,
  type ReconnectOptions,
  type SyntheticEEGOptions,
  startSyntheticStream,
  type WebSocketConstructor,
} from "eegkit";

/** Connection state of a source, as reported to {@link SourceHandlers.onStatus}. */
export type SourceStatus = "idle" | "connecting" | "open" | "closed" | "error";

/** Callbacks a source calls while connected. */
export interface SourceHandlers {
  /** One sample per channel, in µV, in time order. */
  onFrame(frame: Frame): void;
  onStatus?(status: SourceStatus): void;
  onError?(error: unknown): void;
}

/**
 * Anything that produces EEG frames. Create one with {@link syntheticSource},
 * {@link webSocketSource} or {@link manualSource}, or implement it yourself
 * for a Bluetooth device, a native module or a file player.
 *
 * Sources are descriptions, not connections: nothing happens until a hook
 * calls `connect`, and the returned function disconnects. A source may be
 * connected again after it was disconnected.
 */
export interface EEGSource {
  readonly sampleRate: number;
  /** Channel labels, in frame order. */
  readonly channels: readonly string[];
  connect(handlers: SourceHandlers): () => void;
}

/** Channel count or labels. Counts become `ch1`, `ch2`, … */
export type ChannelSpec = number | readonly string[];

function labelsOf(channels: ChannelSpec): string[] {
  if (typeof channels !== "number") {
    if (channels.length === 0) throw new RangeError("channels must not be empty");
    return [...channels];
  }
  if (!(Number.isInteger(channels) && channels > 0)) {
    throw new RangeError(`channels must be a positive integer, got ${channels}`);
  }
  return Array.from({ length: channels }, (_, i) => `ch${i + 1}`);
}

function checkRate(sampleRate: number): void {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
  }
}

/** Options for {@link syntheticSource}. */
export interface SyntheticSourceOptions extends Omit<SyntheticEEGOptions, "channels"> {
  readonly channels: ChannelSpec;
  /** How often frames are delivered, in ms. Default 40. */
  readonly chunkMs?: number;
}

/**
 * Realistic synthetic EEG in real time, for demos, tests and building a UI
 * before the hardware arrives. See eegkit's `createSyntheticEEG` for the
 * signal options (band amplitudes, mains hum, blinks, drift).
 */
export function syntheticSource(options: SyntheticSourceOptions): EEGSource {
  checkRate(options.sampleRate);
  const channels = labelsOf(options.channels);
  return {
    sampleRate: options.sampleRate,
    channels,
    connect({ onFrame, onStatus }) {
      const stop = startSyntheticStream(onFrame, { ...options, channels: channels.length });
      onStatus?.("open");
      return () => {
        stop();
        onStatus?.("closed");
      };
    },
  };
}

/** Options for {@link webSocketSource}. */
export interface WebSocketSourceOptions {
  readonly sampleRate: number;
  readonly channels: ChannelSpec;
  /** Custom message decoder. Default: eegkit's `parseSampleMessage` (JSON, CSV or text). */
  readonly parse?: MessageParser;
  /** Reconnect with exponential back-off after a drop. Default `true`. */
  readonly reconnect?: boolean | ReconnectOptions;
  /** WebSocket implementation, e.g. `ws` on Node < 22. Default: the global `WebSocket`. */
  readonly WebSocket?: WebSocketConstructor;
}

/**
 * Samples from a WebSocket server that sends numbers, e.g. a bridge script
 * next to an amplifier SDK or Lab Streaming Layer. The server decides the
 * sample rate and channel order; tell the source what they are.
 */
export function webSocketSource(url: string, options: WebSocketSourceOptions): EEGSource {
  checkRate(options.sampleRate);
  const channels = labelsOf(options.channels);
  const reconnect = options.reconnect ?? true;
  return {
    sampleRate: options.sampleRate,
    channels,
    connect({ onFrame, onStatus, onError }) {
      onStatus?.("connecting");
      // The socket's close event arrives after `close()` returns; once we
      // closed it ourselves, report nothing more.
      let closed = false;
      let connection: { close(): void };
      try {
        connection = connectWebSocket(
          url,
          {
            onFrame: (frame) => closed || onFrame(frame),
            onOpen: () => closed || onStatus?.("open"),
            onClose: () => closed || onStatus?.(reconnect ? "connecting" : "closed"),
            onError: (error) => closed || onError?.(error),
          },
          {
            reconnect,
            ...(options.parse ? { parse: options.parse } : {}),
            ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
          },
        );
      } catch (error) {
        onStatus?.("error");
        onError?.(error);
        return () => {};
      }
      return () => {
        if (closed) return;
        closed = true;
        connection.close();
        onStatus?.("closed");
      };
    },
  };
}

/** A source you feed yourself. See {@link manualSource}. */
export interface ManualSource extends EEGSource {
  /** Deliver one frame. Ignored while no hook is connected. */
  push(frame: Frame): void;
  /** Deliver a channel-major chunk, `chunk[channel][sample]`. */
  pushChunk(chunk: Chunk): void;
}

/**
 * A source you push frames into, for data that arrives through your own
 * code: Web Bluetooth notifications, Web Serial, a native module, a file.
 *
 * @example
 * ```ts
 * const source = useMemo(() => manualSource({ sampleRate: 250, channels: 8 }), []);
 * const eeg = useEEG(source);
 * useEffect(() => myDevice.onSamples((frame) => source.push(frame)), [source]);
 * ```
 */
export function manualSource(options: {
  readonly sampleRate: number;
  readonly channels: ChannelSpec;
}): ManualSource {
  checkRate(options.sampleRate);
  const channels = labelsOf(options.channels);
  const targets = new Set<(frame: Frame) => void>();
  const frame = new Float64Array(channels.length);
  return {
    sampleRate: options.sampleRate,
    channels,
    connect({ onFrame, onStatus }) {
      targets.add(onFrame);
      onStatus?.("open");
      return () => {
        targets.delete(onFrame);
        onStatus?.("closed");
      };
    },
    push(f) {
      for (const target of targets) target(f);
    },
    pushChunk(chunk) {
      if (chunk.length !== channels.length) {
        throw new RangeError(`expected ${channels.length} channels in chunk, got ${chunk.length}`);
      }
      const length = chunk[0]?.length ?? 0;
      for (let i = 0; i < length; i++) {
        for (let c = 0; c < channels.length; c++) {
          frame[c] = (chunk[c] as ArrayLike<number>)[i] as number;
        }
        for (const target of targets) target(frame);
      }
    },
  };
}
