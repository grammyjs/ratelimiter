import { unref } from '../platform.deno.ts';
import { evaluateGcra, refundGcra } from '../lib/gcra.ts';
import { evaluateTokenBucket, refundTokenBucket } from '../lib/token_bucket.ts';

import type {
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	FixedWindowIncrementResult,
	FixedWindowPreviewOptions,
	GcraConsumeOptions,
	GcraConsumeResult,
	IStorageEngine,
	LimitResult,
	PenaltyEscalationApplyOptions,
	PenaltyEscalationResult,
	PenaltyStrikeState,
	SlidingWindowConsumeOptions,
	SlidingWindowConsumeResult,
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
	TokenBucketState,
} from '../types.ts';

import {
	evaluateSlidingWindow,
	refundSlidingWindow,
	type SlidingWindowState,
} from '../lib/sliding_window.ts';

/** Internal in-memory record with an absolute expiration timestamp. */
interface MemoryRecord<T> {
	state: T;
	expiresAt: number;
}

/** Internal strike state retained until the escalation reset window expires. */
interface PenaltyStrikeRecord {
	strikes: number;
	lastPenaltyTime: number;
}

/**
 * In-process storage backed by a JavaScript `Map`.
 *
 * This store is suitable for a single application process. State is not shared
 * across workers, processes, machines, or restarts. For distributed bots, use a
 * shared storage engine such as `RedisStore`.
 *
 * Expiration is enforced lazily on reads and also by an optional background
 * sweep. Fixed Window, Sliding Window, Token Bucket, GCRA, and escalating-penalty
 * transitions run synchronously inside one JavaScript turn before their promises
 * resolve, making each operation atomic with respect to concurrent middleware
 * calls in the same process.
 */
export class MemoryStore implements IStorageEngine {
	private readonly store = new Map<string, MemoryRecord<unknown>>();
	private readonly cleanupIntervalId?: ReturnType<typeof setInterval>;

	/**
	 * Creates an in-memory store.
	 *
	 * @param cleanupIntervalMs Interval between background expiry sweeps in
	 * milliseconds. Defaults to 30 seconds. Pass `0` or `null` to disable the
	 * background sweep; expired values are still removed lazily when accessed.
	 * Disabling sweeps is useful for short-lived tests, but long-running
	 * applications with many one-off keys should keep periodic cleanup enabled.
	 */
	constructor(cleanupIntervalMs: number | null = 30 * 1000) {
		if (
			cleanupIntervalMs !== null &&
			(!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs < 0)
		) {
			throw new Error(
				'MemoryStore: cleanupIntervalMs must be null or a finite non-negative number.',
			);
		}

		if (cleanupIntervalMs && cleanupIntervalMs > 0) {
			this.cleanupIntervalId = setInterval(() => this.sweep(), cleanupIntervalMs);
			unref(this.cleanupIntervalId);
		}
	}

	/**
	 * Stops the optional background cleanup timer.
	 *
	 * This is mainly useful when applications create and discard store instances
	 * dynamically. Existing records remain available until the store itself is
	 * released. Calling `close()` more than once is harmless.
	 */
	public close(): void {
		if (this.cleanupIntervalId !== undefined) {
			clearInterval(this.cleanupIntervalId);
		}
	}

	/** Removes all currently expired records. */
	private sweep(): void {
		const now = Date.now();

		for (const [key, record] of this.store.entries()) {
			if (record.expiresAt <= now) {
				this.store.delete(key);
			}
		}
	}

	/**
	 * Returns a non-expired record and lazily removes stale entries.
	 *
	 * @param key Storage key.
	 * @param now Current timestamp, injectable by callers to keep multi-step operations consistent.
	 */
	private getRecord<T>(key: string, now = Date.now()): MemoryRecord<T> | undefined {
		const record = this.store.get(key) as MemoryRecord<T> | undefined;

		if (!record) {
			return undefined;
		}

		if (record.expiresAt <= now) {
			this.store.delete(key);

			return undefined;
		}

		return record;
	}

	/** Retrieves arbitrary non-expired strategy state. */
	public get<T>(key: string): Promise<T | undefined> {
		const record = this.getRecord<T>(key);

		return Promise.resolve(record?.state);
	}

	/** Stores arbitrary strategy state with a TTL in milliseconds. */
	public set<T>(key: string, state: T, ttl: number): Promise<void> {
		this.store.set(key, {
			state,
			expiresAt: Date.now() + ttl,
		});

		return Promise.resolve();
	}

	/** Deletes a key immediately. */
	public delete(key: string): Promise<void> {
		this.store.delete(key);

		return Promise.resolve();
	}

	/**
	 * Atomically increments a fixed-window counter without extending an existing window.
	 *
	 * @param key Counter key.
	 * @param ttl Window duration in milliseconds for a newly created window.
	 */
	public increment(key: string, ttl: number): Promise<FixedWindowIncrementResult> {
		const now = Date.now();
		let record = this.getRecord<number>(key, now);

		if (!record) {
			record = {
				state: 1,
				expiresAt: now + ttl,
			};
		} else {
			record.state += 1;
		}

		this.store.set(key, record);

		return Promise.resolve({
			value: record.state,
			reset: Math.max(0, record.expiresAt - now),
		});
	}

	/**
	 * Evaluates a multi-rule limiter chain as one in-process transaction.
	 *
	 * All participating layers use one timestamp. Strategy writes are staged in
	 * memory and are committed only after every penalty check and strategy allows.
	 * A penalty hit or throttled layer therefore leaves all strategy capacity
	 * unchanged.
	 */
	public consumeAtomicLimit(
		layers: readonly AtomicLimitLayerInput[],
	): Promise<AtomicLimitConsumeResult> {
		const now = Date.now();
		const seenKeys = new Set<string>();
		const results: LimitResult[] = [];
		const pending = new Map<string, MemoryRecord<unknown>>();

		for (let index = 0; index < layers.length; index += 1) {
			const layer = layers[index];

			if (!layer) continue;

			const { operation, penaltyKey } = layer;

			if (seenKeys.has(operation.key)) {
				throw new Error(
					`MemoryStore: atomic limiter strategy keys must be unique; duplicate '${operation.key}'.`,
				);
			}

			seenKeys.add(operation.key);

			if (
				penaltyKey !== undefined && this.getRecord<boolean>(penaltyKey, now) !== undefined
			) {
				return Promise.resolve({ outcome: 'penalty-hit', index, results });
			}

			let result: LimitResult;

			switch (operation.kind) {
				case 'fixed-window': {
					const record = this.getRecord<number>(operation.key, now);
					const value = (record?.state ?? 0) + 1;

					result = {
						isAllowed: value <= operation.limit,
						remaining: Math.max(0, operation.limit - value),
						reset: record === undefined
							? operation.timeFrame
							: Math.max(0, record.expiresAt - now),
					};

					if (result.isAllowed) {
						pending.set(operation.key, {
							state: value,
							expiresAt: record?.expiresAt ?? now + operation.timeFrame,
						});
					}

					break;
				}
				case 'sliding-window': {
					const record = this.getRecord<SlidingWindowState>(operation.key, now);
					const transition = evaluateSlidingWindow(now, record?.state, operation.options);

					result = transition.result;

					if (
						result.isAllowed &&
						transition.nextState !== undefined &&
						transition.ttl !== undefined
					) {
						pending.set(operation.key, {
							state: transition.nextState,
							expiresAt: now + transition.ttl,
						});
					}

					break;
				}
				case 'token-bucket': {
					const record = this.getRecord<TokenBucketState>(operation.key, now);
					const transition = evaluateTokenBucket(now, record?.state, operation.options);

					result = {
						isAllowed: transition.result.isAllowed,
						remaining: Math.max(
							0,
							Math.floor(transition.result.tokens / operation.options.cost),
						),
						reset: transition.result.reset,
					};

					if (result.isAllowed) {
						pending.set(operation.key, {
							state: transition.nextState,
							expiresAt: now + operation.options.ttl,
						});
					}

					break;
				}
				case 'gcra': {
					const record = this.getRecord<number>(operation.key, now);
					const transition = evaluateGcra(now, record?.state, operation.options);

					result = transition.result;

					if (
						result.isAllowed &&
						transition.nextTheoreticalArrivalTimeUs !== undefined &&
						transition.ttl !== undefined
					) {
						pending.set(operation.key, {
							state: transition.nextTheoreticalArrivalTimeUs,
							expiresAt: now + transition.ttl,
						});
					}

					break;
				}
			}

			results.push(result);

			if (!result.isAllowed) {
				return Promise.resolve({ outcome: 'throttled', index, results });
			}
		}

		for (const [key, record] of pending) {
			this.store.set(key, record);
		}

		return Promise.resolve({ outcome: 'allowed', results });
	}

	/** Restores one request only when the original Fixed Window is still active. */
	public refundFixedWindow(key: string, maxReset: number): Promise<boolean> {
		const now = Date.now();
		const record = this.getRecord<number>(key, now);

		if (record === undefined) return Promise.resolve(false);

		const reset = record.expiresAt - now;

		if (reset <= 0 || reset > maxReset) return Promise.resolve(false);

		if (record.state <= 1) {
			this.store.delete(key);
		} else {
			this.store.set(key, { state: record.state - 1, expiresAt: record.expiresAt });
		}

		return Promise.resolve(true);
	}

	/** Previews the next Fixed Window decision without incrementing its counter. */
	public previewFixedWindow(
		key: string,
		options: FixedWindowPreviewOptions,
	): Promise<LimitResult> {
		const now = Date.now();
		const record = this.getRecord<number>(key, now);
		const projectedValue = (record?.state ?? 0) + 1;

		return Promise.resolve({
			isAllowed: projectedValue <= options.limit,
			remaining: Math.max(0, options.limit - projectedValue),
			reset: record === undefined ? options.timeFrame : Math.max(0, record.expiresAt - now),
		});
	}

	/**
	 * Atomically evaluates a bounded-memory Sliding Window Counter in this process.
	 *
	 * Denied requests do not consume capacity or extend the stored state's TTL.
	 *
	 * @param key Sliding-window key.
	 * @param options Rolling limit, window duration, and request cost.
	 */
	public consumeSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<SlidingWindowState>(key, now);
		const transition = evaluateSlidingWindow(now, record?.state, options);

		if (transition.nextState !== undefined && transition.ttl !== undefined) {
			this.store.set(key, {
				state: transition.nextState,
				expiresAt: now + transition.ttl,
			});
		}

		return Promise.resolve(transition.result);
	}

	/** Restores one configured request cost to current Sliding Window capacity. */
	public refundSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<void> {
		const now = Date.now();
		const record = this.getRecord<SlidingWindowState>(key, now);

		if (record === undefined) return Promise.resolve();

		const transition = refundSlidingWindow(now, record.state, options);

		if (transition.nextState === undefined) {
			this.store.delete(key);
		} else {
			this.store.set(key, { state: transition.nextState, expiresAt: record.expiresAt });
		}

		return Promise.resolve();
	}

	/** Previews the next Sliding Window decision without consuming capacity. */
	public previewSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<SlidingWindowState>(key, now);

		return Promise.resolve(evaluateSlidingWindow(now, record?.state, options).result);
	}

	/**
	 * Atomically refills a token bucket and consumes the requested cost in this process.
	 *
	 * @param key Bucket key.
	 * @param options Bucket configuration and storage TTL.
	 */
	public consumeTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<TokenBucketState>(key, now);
		const transition = evaluateTokenBucket(now, record?.state, options);

		this.store.set(key, {
			state: transition.nextState,
			expiresAt: now + options.ttl,
		});

		return Promise.resolve(transition.result);
	}

	/** Refills current Token Bucket state and restores one configured request cost. */
	public refundTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<void> {
		const now = Date.now();
		const record = this.getRecord<TokenBucketState>(key, now);

		if (record === undefined) return Promise.resolve();

		const transition = refundTokenBucket(now, record.state, options);

		if (transition.nextState === undefined) {
			this.store.delete(key);
		} else {
			this.store.set(key, {
				state: transition.nextState,
				expiresAt: now + options.ttl,
			});
		}

		return Promise.resolve();
	}

	/** Previews the next Token Bucket decision without consuming or persisting refill state. */
	public previewTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<TokenBucketState>(key, now);

		return Promise.resolve(evaluateTokenBucket(now, record?.state, options).result);
	}

	/**
	 * Atomically evaluates one GCRA schedule in this process.
	 *
	 * The stored value is the theoretical-arrival timestamp in microseconds.
	 * Denied requests never mutate or extend the schedule.
	 */
	public consumeGcra(
		key: string,
		options: GcraConsumeOptions,
	): Promise<GcraConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<number>(key, now);
		const transition = evaluateGcra(now, record?.state, options);

		if (transition.nextTheoreticalArrivalTimeUs !== undefined && transition.ttl !== undefined) {
			this.store.set(key, {
				state: transition.nextTheoreticalArrivalTimeUs,
				expiresAt: now + transition.ttl,
			});
		}

		return Promise.resolve(transition.result);
	}

	/** Restores one configured request cost to the current GCRA schedule. */
	public refundGcra(key: string, options: GcraConsumeOptions): Promise<void> {
		const now = Date.now();
		const record = this.getRecord<number>(key, now);

		if (record === undefined) return Promise.resolve();

		const transition = refundGcra(now, record.state, options);

		if (
			transition.nextTheoreticalArrivalTimeUs === undefined ||
			transition.ttl === undefined
		) {
			this.store.delete(key);
		} else {
			this.store.set(key, {
				state: transition.nextTheoreticalArrivalTimeUs,
				expiresAt: now + transition.ttl,
			});
		}

		return Promise.resolve();
	}

	/** Previews the next GCRA decision without advancing its virtual schedule. */
	public previewGcra(
		key: string,
		options: GcraConsumeOptions,
	): Promise<GcraConsumeResult> {
		const now = Date.now();
		const record = this.getRecord<number>(key, now);

		return Promise.resolve(evaluateGcra(now, record?.state, options).result);
	}

	/** Stores a penalty marker for the supplied duration. */
	public setPenalty(key: string, ttl: number): Promise<void> {
		this.store.set(key, {
			state: true,
			expiresAt: Date.now() + ttl,
		});

		return Promise.resolve();
	}

	/** Returns whether a non-expired penalty marker exists. */
	public checkPenalty(key: string): Promise<boolean> {
		return Promise.resolve(this.getRecord<boolean>(key) !== undefined);
	}

	/**
	 * Atomically advances strike state and stores the resulting escalated penalty.
	 *
	 * Both records are updated synchronously in the same JavaScript turn, so a
	 * concurrent in-process throttle cannot overwrite a stronger penalty with a
	 * weaker one.
	 */
	public applyEscalatingPenalty(
		penaltyKey: string,
		strikeKey: string,
		options: PenaltyEscalationApplyOptions,
	): Promise<PenaltyEscalationResult> {
		const now = Date.now();
		const existing = this.getRecord<PenaltyStrikeRecord>(strikeKey, now);
		const strikes = (existing?.state.strikes ?? 0) + 1;
		const previousPenaltyTime = existing?.state.lastPenaltyTime;
		let penaltyTime = Math.ceil(options.basePenaltyTime);

		if (previousPenaltyTime !== undefined) {
			const effectiveMax = Math.max(
				options.basePenaltyTime,
				options.maxPenaltyTime,
				previousPenaltyTime,
			);
			const scaled = previousPenaltyTime * options.factor;

			penaltyTime = Math.ceil(Math.max(
				options.basePenaltyTime,
				Math.min(effectiveMax, Number.isFinite(scaled) ? scaled : effectiveMax),
			));
		}

		this.store.set(strikeKey, {
			state: { strikes, lastPenaltyTime: penaltyTime },
			expiresAt: now + options.resetAfter,
		});
		this.store.set(penaltyKey, {
			state: true,
			expiresAt: now + penaltyTime,
		});

		return Promise.resolve({ strikes, penaltyTime, reset: options.resetAfter });
	}

	/** Returns current escalation strike state without mutating it. */
	public getPenaltyStrikeState(strikeKey: string): Promise<PenaltyStrikeState | undefined> {
		const now = Date.now();
		const record = this.getRecord<PenaltyStrikeRecord>(strikeKey, now);

		return Promise.resolve(
			record === undefined ? undefined : {
				strikes: record.state.strikes,
				lastPenaltyTime: record.state.lastPenaltyTime,
				reset: Math.max(0, record.expiresAt - now),
			},
		);
	}

	/** Returns the remaining lifetime of an active penalty marker. */
	public getPenaltyTtl(key: string): Promise<number | undefined> {
		const now = Date.now();
		const record = this.getRecord<boolean>(key, now);

		return Promise.resolve(
			record === undefined ? undefined : Math.max(0, record.expiresAt - now),
		);
	}
}
