import type { GcraConsumeOptions, GcraConsumeResult } from '../types.ts';

const MICROSECONDS_PER_MILLISECOND = 1_000;

/** @internal Result of one pure GCRA state transition. */
export interface GcraTransition {
	readonly result: GcraConsumeResult;
	/** Updated theoretical-arrival time in microseconds. Present only when allowed. */
	readonly nextTheoreticalArrivalTimeUs?: number;
	/** Storage TTL in milliseconds for the updated state. Present only when allowed. */
	readonly ttl?: number;
}

/**
 * @internal Evaluates one GCRA request without performing storage I/O.
 *
 * Time is represented in microseconds internally so rates faster than one unit
 * per millisecond retain useful precision while the public API remains in
 * milliseconds.
 */
export function evaluateGcra(
	nowMs: number,
	storedTheoreticalArrivalTimeUs: number | undefined,
	options: GcraConsumeOptions,
): GcraTransition {
	const nowUs = nowMs * MICROSECONDS_PER_MILLISECOND;
	const emissionIntervalUs = (options.interval * MICROSECONDS_PER_MILLISECOND) / options.rate;
	const burstToleranceUs = (options.burst - 1) * emissionIntervalUs;
	const requestSpacingUs = options.cost * emissionIntervalUs;

	const requestThresholdUs = nowUs + burstToleranceUs -
		(options.cost - 1) * emissionIntervalUs;
	const theoreticalArrivalTimeUs = Math.max(
		nowUs,
		storedTheoreticalArrivalTimeUs ?? nowUs,
	);

	const isAllowed = theoreticalArrivalTimeUs <= requestThresholdUs;
	const effectiveTheoreticalArrivalTimeUs = isAllowed
		? theoreticalArrivalTimeUs + requestSpacingUs
		: theoreticalArrivalTimeUs;

	const remaining = effectiveTheoreticalArrivalTimeUs <= requestThresholdUs
		? Math.floor(
			(requestThresholdUs - effectiveTheoreticalArrivalTimeUs) / requestSpacingUs,
		) + 1
		: 0;
	const reset = Math.max(
		0,
		Math.ceil(
			(effectiveTheoreticalArrivalTimeUs - requestThresholdUs) /
				MICROSECONDS_PER_MILLISECOND,
		),
	);

	if (!isAllowed) {
		return {
			result: { isAllowed: false, remaining, reset },
		};
	}

	return {
		result: { isAllowed: true, remaining, reset },
		nextTheoreticalArrivalTimeUs: effectiveTheoreticalArrivalTimeUs,
		ttl: Math.max(
			1,
			Math.ceil(
				(effectiveTheoreticalArrivalTimeUs - nowUs) / MICROSECONDS_PER_MILLISECOND,
			),
		),
	};
}

/** @internal Result of restoring one configured request cost to a GCRA schedule. */
export interface GcraRefundTransition {
	/** Updated theoretical-arrival time, omitted when no persisted schedule is needed. */
	readonly nextTheoreticalArrivalTimeUs?: number;
	/** TTL for the updated schedule. */
	readonly ttl?: number;
}

/** @internal Restores one configured request cost from the current GCRA schedule. */
export function refundGcra(
	nowMs: number,
	storedTheoreticalArrivalTimeUs: number | undefined,
	options: GcraConsumeOptions,
): GcraRefundTransition {
	if (storedTheoreticalArrivalTimeUs === undefined) {
		return {};
	}

	const nowUs = nowMs * MICROSECONDS_PER_MILLISECOND;
	const emissionIntervalUs = (options.interval * MICROSECONDS_PER_MILLISECOND) / options.rate;
	const requestSpacingUs = options.cost * emissionIntervalUs;
	const refunded = storedTheoreticalArrivalTimeUs - requestSpacingUs;

	if (refunded <= nowUs) {
		return {};
	}

	return {
		nextTheoreticalArrivalTimeUs: refunded,
		ttl: Math.max(1, Math.ceil((refunded - nowUs) / MICROSECONDS_PER_MILLISECOND)),
	};
}
