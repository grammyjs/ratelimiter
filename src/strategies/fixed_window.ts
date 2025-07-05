import type { FixedWindowState, ILimiterStrategy, IStorageEngine, LimitResult } from '../types.ts';

export interface FixedWindowStrategyOptions extends Record<string, unknown> {
	// The maximum number of requests allowed in a single window.
	limit: number;
	// The duration of the window in milliseconds.
	timeFrame: number;
}

/**
 * Implements the Fixed Window rate-limiting algorithm.
 */
export class FixedWindowStrategy implements ILimiterStrategy<FixedWindowState> {
	public readonly options: FixedWindowStrategyOptions;

	constructor(options: FixedWindowStrategyOptions) {
		if (options.limit <= 0 || options.timeFrame <= 0) {
			throw new Error('FixedWindowStrategy: limit and timeFrame must be positive numbers.');
		}

		this.options = options;
	}

	/**
	 * Checks if a request is allowed to pass.
	 *
	 * @param key The unique key for the entity being limited.
	 * @param storage The storage engine to use for tracking hits.
	 * @returns A promise that resolves to a `LimitResult`.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const hits = await storage.increment(key, this.options.timeFrame);
		const isAllowed = hits <= this.options.limit;
		const remaining = Math.max(0, this.options.limit - hits);
		const reset = this.options.timeFrame;

		return { isAllowed, remaining, reset };
	}
}
