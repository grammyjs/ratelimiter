import type {
	AtomicSlidingWindowOperation,
	ILimiterStrategy,
	IStorageEngine,
	LimitResult,
	SlidingWindowConsumeOptions,
} from '../types.ts';

/** Static configuration accepted by `SlidingWindowStrategy`. */
export interface SlidingWindowStrategyOptions extends Record<string, unknown> {
	/** Maximum cost units admitted during the rolling window. */
	readonly limit: number;
	/** Rolling-window duration in milliseconds. */
	readonly timeFrame: number;
	/** Cost units consumed by the current request. Defaults to `1`. */
	readonly cost?: number;
}

/**
 * Bounded-memory Sliding Window Counter strategy.
 *
 * The algorithm retains two adjacent fixed buckets per key. The current bucket
 * counts in full while the previous bucket is weighted by the fraction of the
 * current window that remains. This significantly reduces fixed-window boundary
 * bursts without the unbounded per-request storage cost of an exact sliding log.
 *
 * Denied requests do not consume capacity. `remaining` reports how many
 * additional whole requests at the current request's cost can pass immediately,
 * and `reset` reports the delay until another request at that cost can pass.
 */
export class SlidingWindowStrategy implements ILimiterStrategy {
	/** Normalized immutable strategy options. `cost` is always populated. */
	public readonly options: Readonly<SlidingWindowStrategyOptions & { readonly cost: number }>;

	/**
	 * Creates a sliding-window strategy.
	 *
	 * @param options Rolling limit, window duration, and optional request cost.
	 * @throws If limit/cost are non-finite or non-positive, `timeFrame` is not a
	 * positive integer, cost exceeds limit, or the derived storage TTL overflows.
	 */
	constructor(options: SlidingWindowStrategyOptions) {
		const cost = options.cost ?? 1;

		if (
			!Number.isFinite(options.limit) ||
			!Number.isFinite(cost) ||
			!Number.isInteger(options.timeFrame) ||
			options.limit <= 0 ||
			cost <= 0 ||
			options.timeFrame <= 0 ||
			cost > options.limit
		) {
			throw new Error(
				'SlidingWindowStrategy: limit and cost must be finite positive numbers, ' +
					'timeFrame must be a positive integer, and cost must not exceed limit.',
			);
		}

		const storageTtl = options.timeFrame * 2;

		if (!Number.isSafeInteger(storageTtl) || storageTtl <= 0) {
			throw new Error(
				'SlidingWindowStrategy: calculated storage TTL is outside the supported numeric range.',
			);
		}

		this.options = Object.freeze({
			limit: options.limit,
			timeFrame: options.timeFrame,
			cost,
		});
	}

	/**
	 * Evaluates one request through the storage engine's atomic sliding-window primitive.
	 *
	 * @param key Unique storage key for the limited entity.
	 * @param storage Storage engine implementing atomic Sliding Window consumption.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const options: SlidingWindowConsumeOptions = this.options;

		return await storage.consumeSlidingWindow(key, options);
	}

	/** Previews the next Sliding Window decision without consuming capacity. */
	public async preview(key: string, storage: IStorageEngine): Promise<LimitResult | undefined> {
		const options: SlidingWindowConsumeOptions = this.options;

		return await storage.previewSlidingWindow?.(key, options);
	}

	/** Clears all persisted state owned by this strategy for `key`. */
	public async reset(key: string, storage: IStorageEngine): Promise<void> {
		await storage.delete(key);
	}

	/** Restores one configured request cost to current Sliding Window capacity. */
	public async refund(key: string, storage: IStorageEngine): Promise<boolean> {
		if (storage.refundSlidingWindow === undefined) return false;

		await storage.refundSlidingWindow(key, this.options);

		return true;
	}

	/** Describes this strategy for all-or-nothing atomic composition. */
	public toAtomicOperation(key: string): AtomicSlidingWindowOperation {
		const options: SlidingWindowConsumeOptions = this.options;

		return { kind: 'sliding-window', key, options };
	}
}
