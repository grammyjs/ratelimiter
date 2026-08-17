import type {
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
	TokenBucketState,
} from '../types.ts';

/** @internal Pure Token Bucket transition used by in-memory consumption and preview. */
export interface TokenBucketTransition {
	readonly result: TokenBucketConsumeResult;
	readonly nextState: TokenBucketState;
}

/**
 * @internal Evaluates one Token Bucket request without performing storage I/O.
 *
 * The returned state is a fresh object, so callers may preview a request without
 * mutating a previously persisted state object.
 */
export function evaluateTokenBucket(
	now: number,
	storedState: TokenBucketState | undefined,
	options: TokenBucketConsumeOptions,
): TokenBucketTransition {
	let tokens = storedState?.tokens ?? options.bucketSize;
	let lastRefill = storedState?.lastRefill ?? now;

	tokens = Math.min(options.bucketSize, Math.max(0, tokens));

	if (lastRefill > now) {
		lastRefill = now;
	}

	const elapsed = now - lastRefill;

	if (elapsed > 0) {
		tokens = Math.min(
			options.bucketSize,
			tokens + (elapsed / options.interval) * options.tokensPerInterval,
		);
		lastRefill = now;
	}

	const isAllowed = tokens >= options.cost;
	if (isAllowed) {
		tokens -= options.cost;
	}

	const reset = tokens >= options.cost
		? 0
		: Math.ceil((options.cost - tokens) * (options.interval / options.tokensPerInterval));

	return {
		result: { isAllowed, tokens, reset },
		nextState: { tokens, lastRefill },
	};
}

/** @internal Pure Token Bucket refund transition. */
export interface TokenBucketRefundTransition {
	/** Updated state, omitted when a full bucket can be represented by no record. */
	readonly nextState?: TokenBucketState;
}

/** @internal Refills to `now` and restores one configured request cost. */
export function refundTokenBucket(
	now: number,
	storedState: TokenBucketState | undefined,
	options: TokenBucketConsumeOptions,
): TokenBucketRefundTransition {
	if (storedState === undefined) {
		return {};
	}

	let tokens = Math.min(options.bucketSize, Math.max(0, storedState.tokens));
	const lastRefill = Math.min(now, storedState.lastRefill);
	const elapsed = now - lastRefill;

	if (elapsed > 0) {
		tokens = Math.min(
			options.bucketSize,
			tokens + (elapsed / options.interval) * options.tokensPerInterval,
		);
	}

	tokens = Math.min(options.bucketSize, tokens + options.cost);
	if (tokens >= options.bucketSize - Number.EPSILON) {
		return {};
	}

	return { nextState: { tokens, lastRefill: now } };
}
