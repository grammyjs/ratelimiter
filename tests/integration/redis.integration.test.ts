import { assert, assertEquals } from '@std/assert';
import { RedisStore } from '../../src/stores/redis.ts';
import { RealRedisClient } from '../support/real_redis_client.ts';
import type { AtomicLimitLayerInput } from '../../src/types.ts';

const redisUrl = Deno.env.get('RATELIMITER_REDIS_URL');

if (redisUrl === undefined || redisUrl.trim() === '') {
	throw new Error(
		'RATELIMITER_REDIS_URL is required. Point it at a disposable Redis instance, for example redis://127.0.0.1:6379.',
	);
}

const suiteId = crypto.randomUUID();
const key = (name: string): string => `{ratelimiter-it:${suiteId}}:${name}`;
const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

Deno.test('real Redis executes fixed-window Lua and recovers after SCRIPT FLUSH', async () => {
	const client = new RealRedisClient(redisUrl);
	const storage = new RedisStore(client);
	const counterKey = key('fixed');

	try {
		await client.ping();

		const first = await storage.increment(counterKey, 1_000);

		assertEquals(first.value, 1);
		assert(first.reset > 0 && first.reset <= 1_000);

		await client.flushScripts();

		const second = await storage.increment(counterKey, 1_000);

		assertEquals(second.value, 2);
		assert(second.reset > 0 && second.reset <= first.reset);
	} finally {
		await storage.delete(counterKey);
	}
});

Deno.test('real Redis runs Sliding Window consumption and non-consuming preview', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const limiterKey = key('sliding');
	const options = { limit: 2, timeFrame: 10_000, cost: 1 };

	try {
		assertEquals((await storage.consumeSlidingWindow(limiterKey, options)).isAllowed, true);
		assertEquals((await storage.consumeSlidingWindow(limiterKey, options)).isAllowed, true);

		const preview = await storage.previewSlidingWindow(limiterKey, options);

		assertEquals(preview.isAllowed, false);
		assertEquals((await storage.previewSlidingWindow(limiterKey, options)).isAllowed, false);
		assertEquals((await storage.consumeSlidingWindow(limiterKey, options)).isAllowed, false);
	} finally {
		await storage.delete(limiterKey);
	}
});

Deno.test('real Redis uses server time for Token Bucket refill across store instances', async () => {
	const firstStore = new RedisStore(new RealRedisClient(redisUrl));
	const secondStore = new RedisStore(new RealRedisClient(redisUrl));
	const limiterKey = key('token');
	const options = {
		bucketSize: 2,
		tokensPerInterval: 1,
		interval: 100,
		cost: 1,
		ttl: 1_000,
	};

	try {
		assertEquals((await firstStore.consumeTokenBucket(limiterKey, options)).isAllowed, true);
		assertEquals((await secondStore.consumeTokenBucket(limiterKey, options)).isAllowed, true);
		assertEquals((await firstStore.consumeTokenBucket(limiterKey, options)).isAllowed, false);

		await sleep(130);
		assertEquals((await secondStore.consumeTokenBucket(limiterKey, options)).isAllowed, true);
	} finally {
		await firstStore.delete(limiterKey);
	}
});

Deno.test('real Redis enforces GCRA burst and recovery using server time', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const limiterKey = key('gcra');
	const options = { rate: 1, interval: 100, burst: 2, cost: 1 };

	try {
		assertEquals((await storage.consumeGcra(limiterKey, options)).isAllowed, true);
		assertEquals((await storage.consumeGcra(limiterKey, options)).isAllowed, true);
		assertEquals((await storage.consumeGcra(limiterKey, options)).isAllowed, false);

		await sleep(130);
		assertEquals((await storage.consumeGcra(limiterKey, options)).isAllowed, true);
	} finally {
		await storage.delete(limiterKey);
	}
});

Deno.test('real Redis persists penalty TTL and atomic escalating strike state', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const penaltyKey = key('penalty');
	const strikeKey = key('strikes');
	const options = {
		basePenaltyTime: 100,
		factor: 2,
		maxPenaltyTime: 400,
		resetAfter: 2_000,
	};

	try {
		assertEquals(await storage.applyEscalatingPenalty(penaltyKey, strikeKey, options), {
			strikes: 1,
			penaltyTime: 100,
			reset: 2_000,
		});
		assertEquals(
			(await storage.applyEscalatingPenalty(penaltyKey, strikeKey, options)).strikes,
			2,
		);

		const strikeState = await storage.getPenaltyStrikeState(strikeKey);

		assertEquals(strikeState?.strikes, 2);
		assertEquals(strikeState?.lastPenaltyTime, 200);
		assert(strikeState !== undefined && strikeState.reset > 0 && strikeState.reset <= 2_000);

		const penaltyTtl = await storage.getPenaltyTtl(penaltyKey);

		assert(penaltyTtl !== undefined && penaltyTtl > 0 && penaltyTtl <= 200);
	} finally {
		await Promise.all([storage.delete(penaltyKey), storage.delete(strikeKey)]);
	}
});

Deno.test('real Redis atomic limiter rolls every strategy key back when a later layer throttles', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const firstKey = key('atomic:first');
	const secondKey = key('atomic:second');
	const layers: readonly AtomicLimitLayerInput[] = [
		{
			operation: {
				kind: 'fixed-window',
				key: firstKey,
				limit: 2,
				timeFrame: 10_000,
			},
		},
		{
			operation: {
				kind: 'fixed-window',
				key: secondKey,
				limit: 1,
				timeFrame: 10_000,
			},
		},
	];

	try {
		assertEquals((await storage.consumeAtomicLimit(layers)).outcome, 'allowed');

		const rejected = await storage.consumeAtomicLimit(layers);

		assertEquals(rejected.outcome, 'throttled');

		if (rejected.outcome === 'throttled') assertEquals(rejected.index, 1);

		assertEquals(await storage.get<number>(firstKey), 1);
		assertEquals(await storage.get<number>(secondKey), 1);
	} finally {
		await Promise.all([storage.delete(firstKey), storage.delete(secondKey)]);
	}
});

Deno.test('real Redis atomic limiter reports a first-layer penalty hit without consuming', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const strategyKey = key('atomic:penalty:strategy');
	const penaltyKey = key('atomic:penalty:box');
	const layers: readonly AtomicLimitLayerInput[] = [{
		operation: { kind: 'fixed-window', key: strategyKey, limit: 5, timeFrame: 10_000 },
		penaltyKey,
	}];

	try {
		await storage.setPenalty(penaltyKey, 10_000);

		const rejected = await storage.consumeAtomicLimit(layers);

		assertEquals(rejected.outcome, 'penalty-hit');
		if (rejected.outcome === 'penalty-hit') assertEquals(rejected.index, 0);
		assertEquals(rejected.results, []);
		assertEquals(await storage.get<number>(strategyKey), undefined);
	} finally {
		await Promise.all([storage.delete(strategyKey), storage.delete(penaltyKey)]);
	}
});

Deno.test('real Redis atomic limiter admits exactly the configured capacity under concurrency', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const limiterKey = key('atomic:concurrency');
	const layers: readonly AtomicLimitLayerInput[] = [{
		operation: {
			kind: 'fixed-window',
			key: limiterKey,
			limit: 5,
			timeFrame: 10_000,
		},
	}];

	try {
		const results = await Promise.all(
			Array.from({ length: 40 }, () => storage.consumeAtomicLimit(layers)),
		);

		assertEquals(results.filter((result) => result.outcome === 'allowed').length, 5);
		assertEquals(results.filter((result) => result.outcome === 'throttled').length, 35);
		assertEquals(await storage.get<number>(limiterKey), 5);
	} finally {
		await storage.delete(limiterKey);
	}
});

Deno.test('real Redis restores one configured request cost through refund primitives', async () => {
	const storage = new RedisStore(new RealRedisClient(redisUrl));
	const fixedKey = key('refund:fixed');
	const slidingKey = key('refund:sliding');
	const tokenKey = key('refund:token');
	const gcraKey = key('refund:gcra');
	const sliding = { limit: 1, timeFrame: 10_000, cost: 1 };
	const token = {
		bucketSize: 1,
		tokensPerInterval: 1,
		interval: 10_000,
		cost: 1,
		ttl: 10_000,
	};
	const gcra = { rate: 1, interval: 10_000, burst: 1, cost: 1 };

	try {
		await storage.increment(fixedKey, 10_000);
		assertEquals(await storage.refundFixedWindow(fixedKey, 10_000), true);
		assertEquals((await storage.increment(fixedKey, 10_000)).value, 1);

		const rolloverKey = key('refund:fixed-rollover');

		await storage.increment(rolloverKey, 40);
		await new Promise((resolve) => setTimeout(resolve, 60));
		await storage.increment(rolloverKey, 1_000);
		assertEquals(await storage.refundFixedWindow(rolloverKey, 10), false);
		assertEquals((await storage.increment(rolloverKey, 1_000)).value, 2);
		await storage.delete(rolloverKey);

		assertEquals((await storage.consumeSlidingWindow(slidingKey, sliding)).isAllowed, true);
		await storage.refundSlidingWindow(slidingKey, sliding);
		assertEquals((await storage.consumeSlidingWindow(slidingKey, sliding)).isAllowed, true);

		assertEquals((await storage.consumeTokenBucket(tokenKey, token)).isAllowed, true);
		await storage.refundTokenBucket(tokenKey, token);
		assertEquals((await storage.consumeTokenBucket(tokenKey, token)).isAllowed, true);

		assertEquals((await storage.consumeGcra(gcraKey, gcra)).isAllowed, true);
		await storage.refundGcra(gcraKey, gcra);
		assertEquals((await storage.consumeGcra(gcraKey, gcra)).isAllowed, true);
	} finally {
		await Promise.all([
			storage.delete(fixedKey),
			storage.delete(slidingKey),
			storage.delete(tokenKey),
			storage.delete(gcraKey),
		]);
	}
});
