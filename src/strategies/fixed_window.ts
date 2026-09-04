import type {
	AtomicFixedWindowOperation,
	ILimiterStrategy,
	IStorageEngine,
	LimitResult,
} from '../types.ts';

/** Configuration for `FixedWindowStrategy`. */
export interface FixedWindowStrategyOptions extends Record<string, unknown> {
	/** Maximum requests allowed during one window. */
	readonly limit: number;
	/** Window duration in milliseconds. */
	readonly timeFrame: number;
}

/**
 * Fixed Window rate-limiting strategy.
 *
 * Each key receives a counter with a fixed expiry. Requests increment that
 * counter atomically, and the window expiry is not extended by later hits.
 */
export class FixedWindowStrategy implements ILimiterStrategy {
	/** Immutable Fixed Window configuration used by this strategy. */
	public readonly options: FixedWindowStrategyOptions;
	private readonly refundDeadlines = new WeakMap<LimitResult, number>();

	/**
	 * Creates a fixed-window strategy.
	 *
	 * @param options Fixed-window limit and duration.
	 * @throws If `limit` or `timeFrame` is not a positive integer.
	 */
	constructor(options: FixedWindowStrategyOptions) {
		if (
			!Number.isInteger(options.limit) ||
			!Number.isInteger(options.timeFrame) ||
			options.limit <= 0 ||
			options.timeFrame <= 0
		) {
			throw new Error(
				'FixedWindowStrategy: limit and timeFrame must be positive integers.',
			);
		}

		this.options = Object.freeze({ ...options });
	}

	/**
	 * Evaluates one request against the key's active fixed window.
	 *
	 * @param key Unique storage key for the limited entity.
	 * @param storage Storage engine whose `increment` operation must be atomic.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const increment = await storage.increment(key, this.options.timeFrame);

		const result: LimitResult = {
			isAllowed: increment.value <= this.options.limit,
			remaining: Math.max(0, Math.floor(this.options.limit - increment.value)),
			reset: increment.reset,
		};

		this.adoptConsumption(result);

		return result;
	}

	/**
	 * Records a consumption produced by a folded penalty-and-strategy storage round
	 * trip so a later receipt-guarded refund behaves exactly as it does after `check()`.
	 */
	public adoptConsumption(result: LimitResult): void {
		if (result.isAllowed) {
			this.refundDeadlines.set(result, Date.now() + result.reset);
		}
	}

	/**
	 * Previews the next Fixed Window decision without incrementing its counter.
	 *
	 * Returns `undefined` when the configured storage engine does not expose the
	 * optional Fixed Window preview capability.
	 */
	public async preview(key: string, storage: IStorageEngine): Promise<LimitResult | undefined> {
		return await storage.previewFixedWindow?.(key, this.options);
	}

	/** Clears all persisted state owned by this strategy for `key`. */
	public async reset(key: string, storage: IStorageEngine): Promise<void> {
		await storage.delete(key);
	}

	/** Restores one successful request while its original Fixed Window is still active. */
	public async refund(
		key: string,
		storage: IStorageEngine,
		result: LimitResult,
	): Promise<boolean> {
		if (storage.refundFixedWindow === undefined) return false;

		const deadline = this.refundDeadlines.get(result);

		if (deadline === undefined) return false;

		const maxReset = Math.ceil(deadline - Date.now());

		if (maxReset <= 0) return false;

		return await storage.refundFixedWindow(key, maxReset);
	}

	/** Describes this strategy for all-or-nothing atomic composition. */
	public toAtomicOperation(key: string): AtomicFixedWindowOperation {
		return { kind: 'fixed-window', key, ...this.options };
	}
}
