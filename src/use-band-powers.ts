import type { BandPowers, PipelineResult } from "eegkit";
import { useMemo } from "react";
import type { EEGState } from "./use-eeg";

/** Options for {@link useBandPowers} and {@link selectBandPowers}. */
export interface BandPowerOptions {
  /** Fractions of total power (default) or absolute µV². */
  readonly relative?: boolean;
  /** A channel index or label, or `"average"` across channels (default). */
  readonly channel?: number | string | "average";
}

/**
 * Band powers from a pipeline result for one channel, or averaged across
 * channels. Returns `undefined` until the first window completes, or when
 * the channel doesn't exist.
 */
export function selectBandPowers(
  result: PipelineResult | undefined,
  options: BandPowerOptions = {},
): BandPowers | undefined {
  if (!result || result.channels.length === 0) return undefined;
  const { relative = true, channel = "average" } = options;
  const pick = (c: PipelineResult["channels"][number]) =>
    relative ? c.relativeBandPower : c.bandPower;

  if (channel !== "average") {
    const match =
      typeof channel === "number"
        ? result.channels[channel]
        : result.channels.find((c) => c.label === channel);
    return match ? pick(match) : undefined;
  }
  const sum: BandPowers = {};
  for (const c of result.channels) {
    for (const [band, value] of Object.entries(pick(c))) sum[band] = (sum[band] ?? 0) + value;
  }
  for (const band of Object.keys(sum)) sum[band] = (sum[band] as number) / result.channels.length;
  return sum;
}

/**
 * The latest band powers, re-computed only when a new window arrives.
 *
 * @example
 * ```tsx
 * const powers = useBandPowers(eeg); // relative, averaged across channels
 * <Bar value={powers?.alpha ?? 0} />
 * ```
 */
export function useBandPowers(
  eeg: EEGState,
  options: BandPowerOptions = {},
): BandPowers | undefined {
  const { relative = true, channel = "average" } = options;
  return useMemo(
    () => selectBandPowers(eeg.result, { relative, channel }),
    [eeg.result, relative, channel],
  );
}
