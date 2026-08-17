import type {
	AtomicGcraOperation,
	GcraConsumeOptions,
	ILimiterStrategy,
	IStorageEngine,
	LimitResult,
} from '../types.ts';

/** Static configuration accepted by `GcraStrategy`. */
export interface GcraStrategyOptions extends Record<string, unknown> {
	/** Sustained number of cost units admitted per `interval`. */
	readonly rate: number;
	/** Rate interval in milliseconds. */
	readonly interval: number;
	/** Maximum cost units that may be admitted immediately after the limiter is fully idle. */
	readonly burst: number;
	/** Cost units consumed by the current request. Defaults to `1`. */
	readonly cost?: number;
}

/**
 * Generic Cell Rate Algorithm (GCRA) strategy.
 *
 * GCRA is the virtual-scheduling form of a leaky bucket. Unlike Fixed Window,
 * it has no window-boundary burst. Unlike Token Bucket, it needs only one
 * theoretical-arrival timestamp per key while still supporting a controlled
 * initial burst.
 *
 * `rate` describes sustained capacity in cost units per `interval`, `burst`
 * describes how many cost units may pass immediately after the key has been
 * idle long enough, and `cost` describes the current request's weight.
 */
export class GcraStrategy implements ILimiterStrategy {
	/** Normalized immutable strategy options. `cost` is always populated. */
	public readonly options: Readonly<GcraStrategyOptions & { readonly cost: number }>;

	/**
	 * Creates a GCRA strategy.
	 *
	 * @param options Sustained rate, interval, burst capacity, and optional request cost.
	 * @throws If any value is non-finite/non-positive, the interval is not a positive integer,
	 * or cost exceeds burst capacity.
	 */
	constructor(options: GcraStrategyOptions) {
		const cost = options.cost ?? 1;

		if (
			!Number.isFinite(options.rate) ||
			!Number.isInteger(options.interval) ||
			!Number.isFinite(options.burst) ||
			!Number.isFinite(cost) ||
			options.rate <= 0 ||
			options.interval <= 0 ||
			options.burst <= 0 ||
			cost <= 0 ||
			cost > options.burst
		) {
			throw new Error(
				'GcraStrategy: rate, burst, and cost must be finite positive numbers, interval must be a positive integer, and cost must not exceed burst.',
			);
		}

		const emissionIntervalUs = (options.interval * 1_000) / options.rate;
		const maximumScheduleUs = options.burst * emissionIntervalUs;

		if (
			!Number.isFinite(emissionIntervalUs) ||
			!Number.isFinite(maximumScheduleUs) ||
			emissionIntervalUs <= 0 ||
			maximumScheduleUs <= 0
		) {
			throw new Error(
				'GcraStrategy: calculated schedule is outside the supported numeric range.',
			);
		}

		this.options = Object.freeze({
			rate: options.rate,
			interval: options.interval,
			burst: options.burst,
			cost,
		});
	}

	/**
	 * Evaluates one request using the storage engine's atomic GCRA primitive.
	 *
	 * `remaining` is the number of additional requests at the current request's
	 * cost that may pass immediately. `reset` is the delay in milliseconds until
	 * another request at that same cost can pass.
	 *
	 * @param key Unique storage key for the limited entity.
	 * @param storage Storage engine implementing atomic GCRA consumption.
	 */
	public async check(key: string, storage: IStorageEngine): Promise<LimitResult> {
		const options: GcraConsumeOptions = this.options;

		return await storage.consumeGcra(key, options);
	}

	/** Previews the next GCRA decision without advancing its virtual schedule. */
	public async preview(key: string, storage: IStorageEngine): Promise<LimitResult | undefined> {
		const options: GcraConsumeOptions = this.options;

		return await storage.previewGcra?.(key, options);
	}

	/** Clears all persisted state owned by this strategy for `key`. */
	public async reset(key: string, storage: IStorageEngine): Promise<void> {
		await storage.delete(key);
	}

	/** Restores one configured request cost to the current GCRA schedule. */
	public async refund(key: string, storage: IStorageEngine): Promise<boolean> {
		if (storage.refundGcra === undefined) return false;

		await storage.refundGcra(key, this.options);

		return true;
	}

	/** Describes this strategy for all-or-nothing atomic composition. */
	public toAtomicOperation(key: string): AtomicGcraOperation {
		const options: GcraConsumeOptions = this.options;

		return { kind: 'gcra', key, options };
	}
}
