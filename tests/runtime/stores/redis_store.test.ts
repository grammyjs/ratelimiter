import { assertEquals } from '@std/assert';
import { FakeClock } from '../../support/fake_clock.ts';
import { RedisStore } from '../../../src/stores/redis.ts';
import { FakeRedisClient } from '../../support/fake_redis_client.ts';

Deno.test('RedisStore reloads an evicted fixed-window script and retries exactly once', async () => {
	const clock = new FakeClock().install();
	const client = new FakeRedisClient(() => clock.now);
	const storage = new RedisStore(client);

	try {
		assertEquals(await storage.increment('key', 1_000), { value: 1, reset: 1_000 });
		assertEquals(client.scriptLoads, 1);

		client.flushScripts();
		assertEquals(await storage.increment('key', 1_000), { value: 2, reset: 1_000 });
		assertEquals(client.scriptLoads, 2);
	} finally {
		clock.restore();
	}
});

Deno.test('RedisStore caches built-in strategy scripts independently', async () => {
	const clock = new FakeClock().install();
	const client = new FakeRedisClient(() => clock.now);
	const storage = new RedisStore(client);

	try {
		await storage.increment('fixed', 1_000);
		await storage.consumeSlidingWindow('sliding', {
			limit: 4,
			timeFrame: 1_000,
			cost: 1,
		});
		await storage.consumeTokenBucket('bucket', {
			bucketSize: 2,
			tokensPerInterval: 1,
			interval: 1_000,
			cost: 1,
			ttl: 2_000,
		});
		await storage.consumeGcra('gcra', {
			rate: 2,
			interval: 1_000,
			burst: 3,
			cost: 1,
		});
		await storage.increment('fixed', 1_000);
		await storage.consumeSlidingWindow('sliding', {
			limit: 4,
			timeFrame: 1_000,
			cost: 1,
		});
		await storage.consumeTokenBucket('bucket', {
			bucketSize: 2,
			tokensPerInterval: 1,
			interval: 1_000,
			cost: 1,
			ttl: 2_000,
		});
		await storage.consumeGcra('gcra', {
			rate: 2,
			interval: 1_000,
			burst: 3,
			cost: 1,
		});

		assertEquals(client.scriptLoads, 4);
	} finally {
		clock.restore();
	}
});

Deno.test('RedisStore caches and reloads escalating-penalty scripts independently', async () => {
	const clock = new FakeClock().install();
	const client = new FakeRedisClient(() => clock.now);
	const storage = new RedisStore(client);
	const options = {
		basePenaltyTime: 100,
		factor: 2,
		maxPenaltyTime: 400,
		resetAfter: 2_000,
	};

	try {
		assertEquals(await storage.applyEscalatingPenalty('penalty', 'strikes', options), {
			strikes: 1,
			penaltyTime: 100,
			reset: 2_000,
		});
		assertEquals(await storage.getPenaltyStrikeState('strikes'), {
			strikes: 1,
			lastPenaltyTime: 100,
			reset: 2_000,
		});
		assertEquals(client.scriptLoads, 2);

		assertEquals(
			(await storage.applyEscalatingPenalty('penalty', 'strikes', options)).strikes,
			2,
		);
		assertEquals(client.scriptLoads, 2);

		client.flushScripts();
		assertEquals(
			(await storage.applyEscalatingPenalty('penalty', 'strikes', options)).strikes,
			3,
		);
		assertEquals(client.scriptLoads, 3);
	} finally {
		clock.restore();
	}
});
