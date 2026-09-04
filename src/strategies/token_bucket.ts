import type {
	AtomicTokenBucketOperation,
	ILimiterStrategy,
	IStorageEngine,
	LimitResult,
	TokenBucketConsumeResult,
} from '../types.ts';

/** Static configuration accepted by `TokenBucketStrategy`. */
export interface TokenBucketStrategyOptions extends Record<string, unknown> {
	/** Maximum tokens the bucket can hold, controlling burst capacity. */
	readonly bucketSize: number;
	/** Number of tokens replenished per `interval`. Fractional refill rates are supported. */
	readonly tokensPerInterval: number;
	/** Refill interval in milliseconds. */
	readonly interval: number;
	/**
	 * Tokens consumed by each request.
	 *
	 * Defaults to `1`. Fractional costs are supported and must not exceed
	 * `bucketSize`.
	 */
	readonly cost?: number;
}

/**
 * Token Bucket rate-limiting strategy.
 *
 * The storage engine performs refill and weighted consumption atomically. This
 * is essential for correctness when several updates for the same key arrive at
 * once or when multiple processes share a distributed store.
 */
export class TokenBucketStrategy implements ILimiterStrategy {
	/** Normalized immutable strategy options. `cost` is always populated. */
	public readonly options: Readonly<TokenBucketStrategyOptions & { readonly cost: number }>;

	/**
	 * TTL for persisted bucket state. Once a bucket has been inactive for this
	 * long it would be completely refilled, so discarding its old state is safe.
	 */
	private readonly storageTtl: number;

	/**
	 * Creates a token-bucket strategy.
	 *
	 * @param options Token-bucket capacity, refill rate, and optional request cost.
	 * @throws If the resolved configuration is not finite/positive, the interval is not a positive integer, or cost exceeds bucket capacity.
	 */
	constructor(options: TokenBucketStrategyOptions) {
		const cost = options.cost ?? 1;

		if (
			!Number.isFinite(options.bucketSize) ||
			!Number.isInteger(options.interval) ||
			!Number.isFinite(options.tokensPerInterval) ||
			!Number.isFinite(cost) ||
			options.bucketSize < 1 ||
			options.interval <= 0 ||
			options.tokensPerInterval <= 0 ||
			cost <= 0 ||
			cost > options.bucketSize
		) {
			throw new Error(
				'TokenBucketStrategy: bucketSize must be at least 1, interval must be a positive integer, tokensPerInterval and cost must be finite positive numbers, and cost must not exceed bucketSize.',
			);
		}

		this.options = Object.freeze({
			bucketSize: options.bucketSize,
			tokensPerInterval: options.tokensPerInterval,
			interval: options.interval,
			cost,
		});

		this.storageTtl = Math.ceil(
			(this.options.bucketSize * this.options.interval) / this.options.tokensPerInterval,
		);

		if (!Number.isFinite(this.storageTtl) || this.storageTtl <= 0) {
			throw new Error('TokenBucketStrategy: calculated storage TTL is invalid.');
		}
	}

	/**
	 * Evaluates one request by atomically refilling and consuming its configured cost.
	 *
	 * `remaining` reports how many additional requests at this strategy's current
	 * cost could pass immediately.
	 *
	 * @param key Unique storage key for the limited entity.
	 * @param storage Storage engine implementing atomic token-bucket consumption.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const result = await storage.consumeTokenBucket(key, {
			...this.options,
			ttl: this.storageTtl,
		});

		return this.toLimitResult(result);
	}

	/** Previews the next Token Bucket decision without consuming tokens. */
	public async preview(key: string, storage: IStorageEngine): Promise<LimitResult | undefined> {
		const result = await storage.previewTokenBucket?.(key, {
			...this.options,
			ttl: this.storageTtl,
		});

		return result === undefined ? undefined : this.toLimitResult(result);
	}

	/** Converts storage-level token balance into the common limiter result shape. */
	private toLimitResult(result: TokenBucketConsumeResult): LimitResult {
		return {
			isAllowed: result.isAllowed,
			remaining: Math.max(0, Math.floor(result.tokens / this.options.cost)),
			reset: result.reset,
		};
	}

	/** Clears all persisted state owned by this strategy for `key`. */
	public async reset(key: string, storage: IStorageEngine): Promise<void> {
		await storage.delete(key);
	}

	/** Restores one configured request cost to current Token Bucket capacity. */
	public async refund(key: string, storage: IStorageEngine): Promise<boolean> {
		if (storage.refundTokenBucket === undefined) return false;

		await storage.refundTokenBucket(key, {
			...this.options,
			ttl: this.storageTtl,
		});

		return true;
	}

	/** Describes this strategy for all-or-nothing atomic composition. */
	public toAtomicOperation(key: string): AtomicTokenBucketOperation {
		return {
			kind: 'token-bucket',
			key,
			options: { ...this.options, ttl: this.storageTtl },
		};
	}
}
