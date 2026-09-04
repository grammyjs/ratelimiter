import type { TokenBucketState } from '../../src/types.ts';
import type { IRedisClient } from '../../src/stores/redis.ts';

interface RedisRecord {
	value: string;
	expiresAt: number;
}

/**
 * Deterministic in-memory simulator for the small Redis command surface used by
 * `RedisStore`.
 *
 * This is deliberately not presented as a Redis replacement. It lets the shared
 * storage contract exercise `RedisStore` without I/O and validates script-cache
 * behavior. The actual Lua programs are still verified later against a real
 * Redis server in the Docker integration suite.
 */
export class FakeRedisClient implements IRedisClient {
	private readonly data = new Map<string, RedisRecord>();
	private readonly scripts = new Map<string, string>();
	private scriptSequence = 0;

	public scriptLoads = 0;
	public failNextEvalWithNoscript = false;

	constructor(private readonly now: () => number = Date.now) {}

	/** Simulates a Redis script-cache flush. */
	public flushScripts(): void {
		this.scripts.clear();
	}

	public scriptLoad(script: string): Promise<string> {
		this.scriptLoads += 1;

		const sha = `sha-${++this.scriptSequence}`;

		this.scripts.set(sha, script);

		return Promise.resolve(sha);
	}

	public evalsha(
		sha: string,
		keys: string[],
		args: (string | number)[],
	): Promise<unknown> {
		if (this.failNextEvalWithNoscript) {
			this.failNextEvalWithNoscript = false;

			return Promise.reject(new Error('NOSCRIPT No matching script'));
		}

		const script = this.scripts.get(sha);

		if (!script) {
			return Promise.reject(new Error('NOSCRIPT No matching script'));
		}

		if (script.includes('grammy-ratelimiter:atomic-limit')) {
			return Promise.resolve(this.evaluateAtomicLimit(keys, args));
		}

		if (script.includes('grammy-ratelimiter:refund-fixed-window')) {
			return Promise.resolve(this.refundFixedWindow(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:refund-sliding-window')) {
			return Promise.resolve(this.refundSlidingWindow(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:refund-token-bucket')) {
			return Promise.resolve(this.refundTokenBucket(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:refund-gcra')) {
			return Promise.resolve(this.refundGcra(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:preview-fixed-window')) {
			return Promise.resolve(
				this.evaluateFixedWindow(keys[0], Number(args[1]), Number(args[0]), false),
			);
		}

		if (script.includes('grammy-ratelimiter:preview-sliding-window')) {
			return Promise.resolve(this.evaluateSlidingWindow(keys[0], args, false));
		}

		if (script.includes('grammy-ratelimiter:preview-token-bucket')) {
			return Promise.resolve(this.evaluateTokenBucket(keys[0], args, false));
		}

		if (script.includes('grammy-ratelimiter:preview-gcra')) {
			return Promise.resolve(this.evaluateGcra(keys[0], args, false));
		}

		if (script.includes('grammy-ratelimiter:escalating-penalty')) {
			return Promise.resolve(this.evaluateEscalatingPenalty(keys[0], keys[1], args));
		}

		if (script.includes('grammy-ratelimiter:penalty-strike')) {
			const record = this.getRecord(keys[0]);

			if (record === undefined) {
				return Promise.resolve([0, 0, -1]);
			}

			const state = JSON.parse(record.value) as { strikes: number; lastPenaltyTime: number };

			return Promise.resolve([
				state.strikes,
				state.lastPenaltyTime,
				Math.max(0, record.expiresAt - this.now()),
			]);
		}

		if (script.includes('grammy-ratelimiter:penalty-ttl')) {
			const record = this.getRecord(keys[0]);

			return Promise.resolve(
				record === undefined ? -2 : Math.max(0, record.expiresAt - this.now()),
			);
		}

		if (script.includes("redis.call('INCR'")) {
			return Promise.resolve(this.evaluateFixedWindow(keys[0], Number(args[0])));
		}

		if (script.includes('grammy-ratelimiter:sliding-window')) {
			return Promise.resolve(this.evaluateSlidingWindow(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:token-bucket')) {
			return Promise.resolve(this.evaluateTokenBucket(keys[0], args));
		}

		if (script.includes('grammy-ratelimiter:gcra')) {
			return Promise.resolve(this.evaluateGcra(keys[0], args));
		}

		return Promise.reject(new Error('FakeRedisClient: unknown Lua script.'));
	}

	public get(key: string): Promise<string | null> {
		return Promise.resolve(this.getRecord(key)?.value ?? null);
	}

	public setWithExpiry(key: string, value: string, ttlMilliseconds: number): Promise<unknown> {
		this.data.set(key, {
			value,
			expiresAt: this.now() + ttlMilliseconds,
		});

		return Promise.resolve('OK');
	}

	public exists(key: string): Promise<number> {
		return Promise.resolve(this.getRecord(key) === undefined ? 0 : 1);
	}

	public del(key: string): Promise<unknown> {
		return Promise.resolve(this.data.delete(key) ? 1 : 0);
	}

	private getRecord(key: string): RedisRecord | undefined {
		const record = this.data.get(key);

		if (!record) {
			return undefined;
		}

		if (record.expiresAt <= this.now()) {
			this.data.delete(key);

			return undefined;
		}

		return record;
	}

	private refundFixedWindow(key: string, args: (string | number)[]): number {
		const record = this.getRecord(key);

		if (record === undefined) return 0;

		const maxReset = Number(args[0]);
		const reset = record.expiresAt - this.now();

		if (reset <= 0 || reset > maxReset) return 0;

		const value = Number(record.value);

		if (value <= 1) {
			this.data.delete(key);
		} else {
			this.data.set(key, { value: String(value - 1), expiresAt: record.expiresAt });
		}

		return 1;
	}

	private refundSlidingWindow(key: string, args: (string | number)[]): number {
		const timeFrame = Number(args[0]);
		const cost = Number(args[1]);
		const epsilon = 1e-9;
		const record = this.getRecord(key);

		if (record === undefined) return 0;

		const now = this.now();
		const windowStart = Math.floor(now / timeFrame) * timeFrame;
		const elapsed = Math.max(0, Math.min(timeFrame, now - windowStart));
		const stored = JSON.parse(record.value) as {
			windowStart: number;
			currentCount: number;
			previousCount: number;
		};
		let currentCount: number;
		let previousCount: number;

		if (stored.windowStart === windowStart) {
			currentCount = stored.currentCount;
			previousCount = stored.previousCount;
		} else if (stored.windowStart + timeFrame === windowStart) {
			currentCount = 0;
			previousCount = stored.currentCount;
		} else {
			this.data.delete(key);

			return 1;
		}

		let credit = cost;
		const currentRefund = Math.min(currentCount, credit);

		currentCount = Math.max(0, currentCount - currentRefund);
		credit -= currentRefund;

		const previousWeight = (timeFrame - elapsed) / timeFrame;

		if (credit > epsilon && previousCount > epsilon && previousWeight > epsilon) {
			const previousRefund = Math.min(previousCount, credit / previousWeight);

			previousCount = Math.max(0, previousCount - previousRefund);
		}

		if (currentCount <= epsilon && previousCount <= epsilon) {
			this.data.delete(key);
		} else {
			this.data.set(key, {
				value: JSON.stringify({ windowStart, currentCount, previousCount }),
				expiresAt: record.expiresAt,
			});
		}

		return 1;
	}

	private refundTokenBucket(key: string, args: (string | number)[]): number {
		const bucketSize = Number(args[0]);
		const tokensPerInterval = Number(args[1]);
		const interval = Number(args[2]);
		const ttl = Number(args[3]);
		const cost = Number(args[4]);
		const record = this.getRecord(key);

		if (record === undefined) return 0;

		const now = this.now();
		const state = JSON.parse(record.value) as TokenBucketState;
		let tokens = Math.min(bucketSize, Math.max(0, state.tokens));
		const lastRefill = Math.min(now, state.lastRefill);
		const elapsed = now - lastRefill;

		if (elapsed > 0) {
			tokens = Math.min(bucketSize, tokens + (elapsed / interval) * tokensPerInterval);
		}

		tokens = Math.min(bucketSize, tokens + cost);

		if (tokens >= bucketSize - 1e-9) {
			this.data.delete(key);
		} else {
			this.data.set(key, {
				value: JSON.stringify({ tokens, lastRefill: now }),
				expiresAt: now + ttl,
			});
		}

		return 1;
	}

	private refundGcra(key: string, args: (string | number)[]): number {
		const rate = Number(args[0]);
		const interval = Number(args[1]);
		const cost = Number(args[2]);
		const record = this.getRecord(key);

		if (record === undefined) return 0;

		const now = this.now();
		const nowUs = now * 1_000;
		const spacing = cost * ((interval * 1_000) / rate);
		const refunded = Number(record.value) - spacing;

		if (refunded <= nowUs) {
			this.data.delete(key);
		} else {
			this.data.set(key, {
				value: String(refunded),
				expiresAt: now + Math.max(1, Math.ceil((refunded - nowUs) / 1_000)),
			});
		}

		return 1;
	}

	private evaluateAtomicLimit(
		keys: string[],
		args: (string | number)[],
	): string {
		type EncodedLayer = {
			kind: 'fixed-window' | 'sliding-window' | 'token-bucket' | 'gcra';
			keyIndex: number;
			penaltyKeyIndex: number;
			limit?: number;
			timeFrame?: number;
			cost?: number;
			bucketSize?: number;
			tokensPerInterval?: number;
			interval?: number;
			ttl?: number;
			rate?: number;
			burst?: number;
		};

		const layers = JSON.parse(String(args[0])) as EncodedLayer[];
		const snapshot = new Map(this.data);
		const results: { isAllowed: boolean; remaining: number; reset: number }[] = [];
		const restore = () => {
			this.data.clear();

			for (const [key, record] of snapshot) {
				this.data.set(key, record);
			}
		};

		for (let index = 0; index < layers.length; index += 1) {
			const layer = layers[index];

			if (!layer) continue;

			const key = keys[layer.keyIndex - 1];

			if (key === undefined) {
				restore();

				throw new Error('FakeRedisClient: atomic limiter referenced an invalid key index.');
			}

			if (layer.penaltyKeyIndex > 0) {
				const penaltyKey = keys[layer.penaltyKeyIndex - 1];

				if (penaltyKey !== undefined && this.getRecord(penaltyKey) !== undefined) {
					restore();

					return JSON.stringify({ outcome: 'penalty-hit', index, results });
				}
			}

			let raw: [number, number, number] | [number, string, number];

			switch (layer.kind) {
				case 'fixed-window':
					raw = this.evaluateFixedWindow(
						key,
						Number(layer.timeFrame),
						Number(layer.limit),
						true,
					) as [number, number, number];
					break;
				case 'sliding-window':
					raw = this.evaluateSlidingWindow(key, [
						Number(layer.limit),
						Number(layer.timeFrame),
						Number(layer.cost),
					], true);
					break;
				case 'token-bucket':
					raw = this.evaluateTokenBucket(key, [
						Number(layer.bucketSize),
						Number(layer.tokensPerInterval),
						Number(layer.interval),
						Number(layer.ttl),
						Number(layer.cost),
					], true);
					break;
				case 'gcra':
					raw = this.evaluateGcra(key, [
						Number(layer.rate),
						Number(layer.interval),
						Number(layer.burst),
						Number(layer.cost),
					], true);
					break;
			}

			const isAllowed = Number(raw[0]) === 1;
			const remaining = layer.kind === 'token-bucket'
				? Math.max(0, Math.floor(Number(raw[1]) / Number(layer.cost)))
				: Math.max(0, Math.floor(Number(raw[1])));
			const result = { isAllowed, remaining, reset: Math.max(0, Number(raw[2])) };

			results.push(result);

			if (!isAllowed) {
				restore();

				return JSON.stringify({ outcome: 'throttled', index, results });
			}
		}

		return JSON.stringify({ outcome: 'allowed', results });
	}

	private evaluateEscalatingPenalty(
		penaltyKey: string,
		strikeKey: string,
		args: (string | number)[],
	): [number, number, number] {
		const basePenaltyTime = Number(args[0]);
		const factor = Number(args[1]);
		const maxPenaltyTime = Number(args[2]);
		const resetAfter = Number(args[3]);
		const now = this.now();
		const strikeRecord = this.getRecord(strikeKey);
		const previous = strikeRecord === undefined
			? undefined
			: JSON.parse(strikeRecord.value) as { strikes: number; lastPenaltyTime: number };
		const strikes = (previous?.strikes ?? 0) + 1;
		let penaltyTime = Math.ceil(basePenaltyTime);

		if (previous !== undefined) {
			const effectiveMax = Math.max(
				basePenaltyTime,
				maxPenaltyTime,
				previous.lastPenaltyTime,
			);
			const scaled = previous.lastPenaltyTime * factor;

			penaltyTime = Math.ceil(Math.max(
				basePenaltyTime,
				Math.min(effectiveMax, Number.isFinite(scaled) ? scaled : effectiveMax),
			));
		}

		this.data.set(strikeKey, {
			value: JSON.stringify({ strikes, lastPenaltyTime: penaltyTime }),
			expiresAt: now + resetAfter,
		});
		this.data.set(penaltyKey, { value: '1', expiresAt: now + penaltyTime });

		return [strikes, penaltyTime, resetAfter];
	}

	private evaluateFixedWindow(
		key: string,
		ttl: number,
		limit?: number,
		persist = true,
	): [number, number] | [number, number, number] {
		const now = this.now();
		const existing = this.getRecord(key);
		const current = existing === undefined ? 1 : Number(existing.value) + 1;
		const expiresAt = existing?.expiresAt ?? now + ttl;

		if (persist) {
			this.data.set(key, {
				value: String(current),
				expiresAt,
			});
		}

		const reset = Math.max(0, expiresAt - now);

		if (limit !== undefined) {
			return [current <= limit ? 1 : 0, Math.max(0, limit - current), reset];
		}

		return [current, reset];
	}

	private evaluateSlidingWindow(
		key: string,
		args: (string | number)[],
		persist = true,
	): [number, number, number] {
		const limit = Number(args[0]);
		const timeFrame = Number(args[1]);
		const cost = Number(args[2]);
		const epsilon = 1e-9;
		const now = this.now();
		const windowStart = Math.floor(now / timeFrame) * timeFrame;
		const elapsed = Math.max(0, Math.min(timeFrame, now - windowStart));
		const existing = this.getRecord(key);
		const stored = existing === undefined ? undefined : JSON.parse(existing.value) as {
			windowStart: number;
			currentCount: number;
			previousCount: number;
		};

		let currentCount = 0;
		let previousCount = 0;

		if (stored?.windowStart === windowStart) {
			currentCount = stored.currentCount;
			previousCount = stored.previousCount;
		} else if (
			stored?.windowStart !== undefined && stored.windowStart + timeFrame === windowStart
		) {
			previousCount = stored.currentCount;
		}

		const previousWeight = (timeFrame - elapsed) / timeFrame;
		const usageBefore = currentCount + previousCount * previousWeight;
		const isAllowed = usageBefore + cost <= limit + epsilon ? 1 : 0;

		if (isAllowed === 1) {
			currentCount += cost;
		}

		const usageAfter = currentCount + previousCount * previousWeight;
		const remaining = Math.max(0, Math.floor((limit - usageAfter + epsilon) / cost));
		const threshold = limit - cost;
		let reset = 0;

		if (usageAfter > threshold + epsilon) {
			const remainingInCurrentWindow = timeFrame - elapsed;
			let resolved = false;

			if (previousCount > epsilon) {
				const delayWithinCurrentWindow = (usageAfter - threshold) * timeFrame /
					previousCount;

				if (delayWithinCurrentWindow <= remainingInCurrentWindow + epsilon) {
					reset = Math.max(0, Math.ceil(delayWithinCurrentWindow - epsilon));
					resolved = true;
				}
			}

			if (!resolved) {
				if (currentCount <= threshold + epsilon) {
					reset = Math.max(0, Math.ceil(remainingInCurrentWindow));
				} else {
					const delayInNextWindow = (currentCount - threshold) * timeFrame / currentCount;

					reset = Math.max(
						0,
						Math.ceil(remainingInCurrentWindow + delayInNextWindow - epsilon),
					);
				}
			}
		}

		if (isAllowed === 1 && persist) {
			this.data.set(key, {
				value: JSON.stringify({ windowStart, currentCount, previousCount }),
				expiresAt: now + timeFrame * 2,
			});
		}

		return [isAllowed, remaining, reset];
	}

	private evaluateTokenBucket(
		key: string,
		args: (string | number)[],
		persist = true,
	): [number, string, number] {
		const bucketSize = Number(args[0]);
		const tokensPerInterval = Number(args[1]);
		const interval = Number(args[2]);
		const ttl = Number(args[3]);
		const cost = Number(args[4]);
		const now = this.now();
		const existing = this.getRecord(key);
		const stored = existing === undefined
			? undefined
			: JSON.parse(existing.value) as TokenBucketState;

		let tokens = stored?.tokens ?? bucketSize;
		let lastRefill = stored?.lastRefill ?? now;

		tokens = Math.min(bucketSize, Math.max(0, tokens));

		if (lastRefill > now) {
			lastRefill = now;
		}

		const elapsed = now - lastRefill;

		if (elapsed > 0) {
			tokens = Math.min(
				bucketSize,
				tokens + (elapsed / interval) * tokensPerInterval,
			);
			lastRefill = now;
		}

		let isAllowed = 0;

		if (tokens >= cost) {
			isAllowed = 1;
			tokens -= cost;
		}

		if (persist) {
			this.data.set(key, {
				value: JSON.stringify({ tokens, lastRefill }),
				expiresAt: now + ttl,
			});
		}

		const reset = tokens >= cost
			? 0
			: Math.ceil((cost - tokens) * (interval / tokensPerInterval));

		return [isAllowed, String(tokens), reset];
	}

	private evaluateGcra(
		key: string,
		args: (string | number)[],
		persist = true,
	): [number, number, number] {
		const rate = Number(args[0]);
		const interval = Number(args[1]);
		const burst = Number(args[2]);
		const cost = Number(args[3]);
		const now = this.now();
		const nowUs = now * 1_000;
		const emissionIntervalUs = (interval * 1_000) / rate;
		const burstToleranceUs = (burst - 1) * emissionIntervalUs;
		const requestSpacingUs = cost * emissionIntervalUs;
		const requestThresholdUs = nowUs + burstToleranceUs -
			(cost - 1) * emissionIntervalUs;
		const existing = this.getRecord(key);
		const theoreticalArrivalTimeUs = Math.max(
			nowUs,
			existing === undefined ? nowUs : Number(existing.value),
		);

		const isAllowed = theoreticalArrivalTimeUs <= requestThresholdUs ? 1 : 0;
		const effectiveTheoreticalArrivalTimeUs = isAllowed === 1
			? theoreticalArrivalTimeUs + requestSpacingUs
			: theoreticalArrivalTimeUs;

		if (isAllowed === 1 && persist) {
			const ttl = Math.max(
				1,
				Math.ceil((effectiveTheoreticalArrivalTimeUs - nowUs) / 1_000),
			);

			this.data.set(key, {
				value: String(effectiveTheoreticalArrivalTimeUs),
				expiresAt: now + ttl,
			});
		}

		const remaining = effectiveTheoreticalArrivalTimeUs <= requestThresholdUs
			? Math.floor(
				(requestThresholdUs - effectiveTheoreticalArrivalTimeUs) / requestSpacingUs,
			) + 1
			: 0;
		const reset = Math.max(
			0,
			Math.ceil((effectiveTheoreticalArrivalTimeUs - requestThresholdUs) / 1_000),
		);

		return [isAllowed, remaining, reset];
	}
}
