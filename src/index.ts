export {
  type ChannelSpec,
  type EEGSource,
  type ManualSource,
  manualSource,
  type SourceHandlers,
  type SourceStatus,
  type SyntheticSourceOptions,
  syntheticSource,
  type WebSocketSourceOptions,
  webSocketSource,
} from "./sources";
export { type BandPowerOptions, selectBandPowers, useBandPowers } from "./use-band-powers";
export { type EEGState, type UseEEGOptions, useEEG } from "./use-eeg";
export {
  type NeurofeedbackOptions,
  type NeurofeedbackState,
  useNeurofeedback,
} from "./use-neurofeedback";
export { type Trace, type UseTraceOptions, useTrace } from "./use-trace";
