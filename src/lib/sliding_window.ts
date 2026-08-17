import type { LimitResult, SlidingWindowConsumeOptions } from '../types.ts';

/** @internal Persisted bounded-memory state for one Sliding Window Counter key. */
export interface SlidingWindowState {
	readonly windowStart: number;
	readonly currentCount: number;
	readonly previousCount: number;
}

/** @internal Result of one in-memory Sliding Window Counter transition. */
export interface SlidingWindowTransition {
	readonly result: LimitResult;
	/** New state to persist. Omitted when a denied request leaves state unchanged. */
	readonly nextState?: SlidingWindowState;
	/** TTL for `nextState`, present whenever `nextState` is present. */
	readonly ttl?: number;
}

const FLOATING_POINT_EPSILON = 1e-9;

/** Returns the start of the fixed bucket containing `now`. */
function getWindowStart(now: number, timeFrame: number): number {
	return Math.floor(now / timeFrame) * timeFrame;
}

/**
 * Normalizes persisted two-bucket state to the fixed bucket containing `now`.
 *
 * State older than the immediately previous bucket cannot contribute to the
 * rolling estimate and is discarded.
 */
function normalizeState(
	now: number,
	state: SlidingWindowState | undefined,
	timeFrame: number,
): SlidingWindowState {
	const windowStart = getWindowStart(now, timeFrame);

	if (!state) {
		return { windowStart, currentCount: 0, previousCount: 0 };
	}

	if (state.windowStart === windowStart) {
		return state;
	}

	if (state.windowStart + timeFrame === windowStart) {
		return {
			windowStart,
			currentCount: 0,
			previousCount: state.currentCount,
		};
	}

	return { windowStart, currentCount: 0, previousCount: 0 };
}

/** Returns weighted usage represented by the normalized two-bucket state. */
function getWeightedUsage(
	now: number,
	state: SlidingWindowState,
	timeFrame: number,
): number {
	const elapsed = Math.max(0, Math.min(timeFrame, now - state.windowStart));
	const previousWeight = (timeFrame - elapsed) / timeFrame;

	return state.currentCount + state.previousCount * previousWeight;
}

/**
 * Computes how long until another request at `cost` can fit without mutating state.
 */
function getResetDelay(
	now: number,
	state: SlidingWindowState,
	options: SlidingWindowConsumeOptions,
): number {
	const { limit, timeFrame, cost } = options;
	const threshold = limit - cost;
	const elapsed = Math.max(0, Math.min(timeFrame, now - state.windowStart));
	const remainingInCurrentWindow = timeFrame - elapsed;
	const usage = getWeightedUsage(now, state, timeFrame);

	if (usage <= threshold + FLOATING_POINT_EPSILON) {
		return 0;
	}

	if (state.previousCount > FLOATING_POINT_EPSILON) {
		const decayNeeded = usage - threshold;
		const delayWithinCurrentWindow = decayNeeded * timeFrame / state.previousCount;

		if (delayWithinCurrentWindow <= remainingInCurrentWindow + FLOATING_POINT_EPSILON) {
			return Math.max(0, Math.ceil(delayWithinCurrentWindow - FLOATING_POINT_EPSILON));
		}
	}

	// At the next bucket boundary the old previous bucket disappears and the
	// current bucket becomes the new previous bucket at full weight.
	if (state.currentCount <= threshold + FLOATING_POINT_EPSILON) {
		return Math.max(0, Math.ceil(remainingInCurrentWindow));
	}

	const delayInNextWindow = (state.currentCount - threshold) * timeFrame / state.currentCount;
	return Math.max(
		0,
		Math.ceil(remainingInCurrentWindow + delayInNextWindow - FLOATING_POINT_EPSILON),
	);
}

/**
 * @internal Evaluates one bounded-memory Sliding Window Counter transition.
 *
 * The current fixed bucket is counted in full. The immediately previous bucket
 * is weighted by the fraction of the current bucket that remains. This smooths
 * fixed-window boundary bursts while retaining O(1) state per key.
 *
 * Denied requests do not consume capacity or extend state lifetime.
 */
export function evaluateSlidingWindow(
	now: number,
	storedState: SlidingWindowState | undefined,
	options: SlidingWindowConsumeOptions,
): SlidingWindowTransition {
	const state = normalizeState(now, storedState, options.timeFrame);
	const usageBefore = getWeightedUsage(now, state, options.timeFrame);
	const isAllowed = usageBefore + options.cost <= options.limit + FLOATING_POINT_EPSILON;
	const currentCount = isAllowed ? state.currentCount + options.cost : state.currentCount;

	const effectiveState: SlidingWindowState = {
		windowStart: state.windowStart,
		currentCount,
		previousCount: state.previousCount,
	};

	const usageAfter = getWeightedUsage(now, effectiveState, options.timeFrame);
	const remaining = Math.max(
		0,
		Math.floor(
			(options.limit - usageAfter + FLOATING_POINT_EPSILON) / options.cost,
		),
	);
	const reset = getResetDelay(now, effectiveState, options);

	return {
		result: { isAllowed, remaining, reset },
		...(isAllowed
			? {
				nextState: effectiveState,
				ttl: options.timeFrame * 2,
			}
			: {}),
	};
}

/** @internal Result of restoring one request cost to Sliding Window aggregate state. */
export interface SlidingWindowRefundTransition {
	/** Updated normalized state. Omitted when no persisted state is needed. */
	readonly nextState?: SlidingWindowState;
}

/**
 * @internal Restores one configured request cost to current rolling capacity.
 *
 * The refund is expressed against aggregate weighted usage at refund time. It
 * removes from the full-weight current bucket first, then from the weighted
 * previous bucket only when necessary, so the immediate capacity credit is as
 * close as possible to the original configured cost without request journals.
 */
export function refundSlidingWindow(
	now: number,
	storedState: SlidingWindowState | undefined,
	options: SlidingWindowConsumeOptions,
): SlidingWindowRefundTransition {
	if (storedState === undefined) {
		return {};
	}

	const state = normalizeState(now, storedState, options.timeFrame);
	const elapsed = Math.max(0, Math.min(options.timeFrame, now - state.windowStart));
	const previousWeight = (options.timeFrame - elapsed) / options.timeFrame;
	let currentCount = state.currentCount;
	let previousCount = state.previousCount;
	let credit = options.cost;

	const currentRefund = Math.min(currentCount, credit);
	currentCount = Math.max(0, currentCount - currentRefund);
	credit -= currentRefund;

	if (
		credit > FLOATING_POINT_EPSILON &&
		previousCount > FLOATING_POINT_EPSILON &&
		previousWeight > FLOATING_POINT_EPSILON
	) {
		const rawPreviousRefund = Math.min(previousCount, credit / previousWeight);
		previousCount = Math.max(0, previousCount - rawPreviousRefund);
	}

	if (
		currentCount <= FLOATING_POINT_EPSILON &&
		previousCount <= FLOATING_POINT_EPSILON
	) {
		return {};
	}

	return {
		nextState: {
			windowStart: state.windowStart,
			currentCount,
			previousCount,
		},
	};
}
