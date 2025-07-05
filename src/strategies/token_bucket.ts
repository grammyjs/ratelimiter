import type { ILimiterStrategy, IStorageEngine, LimitResult, TokenBucketState } from '../types.ts';

/**
 * Configuration options for the TokenBucketStrategy.
 */
export interface TokenBucketStrategyOptions extends Record<string, unknown> {
	// The maximum number of tokens the bucket can hold. Defines the burst limit.
	bucketSize: number;
	// The time interval (in milliseconds) for token refills.
	interval: number;
	// The number of tokens added to the bucket per interval. Defines the sustained rate.
	tokensPerInterval: number;
}

/**
 * Implements the Token Bucket rate-limiting algorithm.
 */
export class TokenBucketStrategy implements ILimiterStrategy<TokenBucketState> {
	public readonly options: TokenBucketStrategyOptions;

	/**
	 * The Time-To-Live for records in storage. This should be long enough to
	 * ensure a user's state doesn't vanish while they are active.
	 */
	private readonly storageTtl: number;

	/**
	 * Constructs a new `TokenBucketStrategy`.
	 *
	 * @param options The configuration for the token bucket algorithm.
	 */
	constructor(options: TokenBucketStrategyOptions) {
		if (options.bucketSize <= 0 || options.interval <= 0 || options.tokensPerInterval <= 0) {
			throw new Error(
				'TokenBucketStrategy: bucketSize, interval, and tokensPerInterval must be positive numbers.',
			);
		}

		this.options = options;

		const timeToFill = Math.ceil(this.options.bucketSize / this.options.tokensPerInterval) *
			this.options.interval;
		this.storageTtl = timeToFill;
	}

	/**
	 * Executes the token bucket algorithm for a given request.
	 *
	 * This method gets the user's current state, refills their token bucket
	 * based on the elapsed time, consumes a token if available, and saves
	 * the new state back to storage.
	 *
	 * @param key The unique key for the entity being limited.
	 * @param storage The storage engine used to persist the token bucket state.
	 * @returns A promise that resolves to a `LimitResult`.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const now = Date.now();
		const currentState = await storage.get(key);

		const state = currentState ?? {
			tokens: this.options.bucketSize,
			lastRefill: now,
		};

		this.refill(state, now);

		let isAllowed: boolean;

		if (state.tokens >= 1) {
			isAllowed = true;
			state.tokens -= 1;
		} else {
			isAllowed = false;
		}

		await storage.set(key, state, this.storageTtl);

		const remaining = Math.floor(state.tokens);
		const reset = this.calculateReset(state.tokens);

		return { isAllowed, remaining, reset };
	}

	/**
	 * Calculates the number of tokens to add to the bucket based on elapsed time
	 *
	 * @param state The current `TokenBucketState` for the user.
	 * @param now The current timestamp from `Date.now()`.
	 */
	private refill(state: TokenBucketState, now: number): void {
		const elapsed = now - state.lastRefill;

		if (elapsed <= 0) {
			return;
		}

		const tokensToAdd = (elapsed / this.options.interval) * this.options.tokensPerInterval;
		state.tokens = Math.min(this.options.bucketSize, state.tokens + tokensToAdd);
		state.lastRefill = now;
	}

	/**
	 * Calculates the time in milliseconds until the user will have at least one token.
	 * If the user already has one or more tokens, it returns 0.
	 *
	 * @param currentTokens The user's current token count (can be fractional).
	 * @returns The time in milliseconds until the next token is available.
	 */
	private calculateReset(currentTokens: number): number {
		if (currentTokens >= 1) {
			return 0;
		}

		const needed = 1 - currentTokens;

		const timePerToken = this.options.interval / this.options.tokensPerInterval;
		return Math.ceil(needed * timePerToken);
	}
}
