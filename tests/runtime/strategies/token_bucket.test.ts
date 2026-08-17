import { assertEquals } from '@std/assert';
import { ScriptedStorage } from '../../support/scripted_storage.ts';
import { TokenBucketStrategy } from '../../../src/strategies/token_bucket.ts';

Deno.test('TokenBucketStrategy defaults to cost=1 and forwards normalized options', async () => {
	const storage = new ScriptedStorage();

	storage.tokenBucketResults.push({ isAllowed: true, tokens: 2.75, reset: 0 });

	const strategy = new TokenBucketStrategy({
		bucketSize: 3,
		tokensPerInterval: 1,
		interval: 1_000,
	});

	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: true,
		remaining: 2,
		reset: 0,
	});
	assertEquals(strategy.options.cost, 1);
	assertEquals(storage.consumeTokenBucketCalls, [
		{
			key: 'user:1',
			options: {
				bucketSize: 3,
				tokensPerInterval: 1,
				interval: 1_000,
				cost: 1,
				ttl: 3_000,
			},
		},
	]);
});

Deno.test('TokenBucketStrategy maps weighted token state to request-level remaining capacity', async () => {
	const storage = new ScriptedStorage();

	storage.tokenBucketResults.push(
		{ isAllowed: true, tokens: 4.5, reset: 0 },
		{ isAllowed: false, tokens: 1.25, reset: 375 },
	);

	const strategy = new TokenBucketStrategy({
		bucketSize: 8,
		tokensPerInterval: 2,
		interval: 1_000,
		cost: 2,
	});

	assertEquals(await strategy.check('user:weighted', storage), {
		isAllowed: true,
		remaining: 2,
		reset: 0,
	});
	assertEquals(await strategy.check('user:weighted', storage), {
		isAllowed: false,
		remaining: 0,
		reset: 375,
	});

	assertEquals(storage.consumeTokenBucketCalls, [
		{
			key: 'user:weighted',
			options: {
				bucketSize: 8,
				tokensPerInterval: 2,
				interval: 1_000,
				cost: 2,
				ttl: 4_000,
			},
		},
		{
			key: 'user:weighted',
			options: {
				bucketSize: 8,
				tokensPerInterval: 2,
				interval: 1_000,
				cost: 2,
				ttl: 4_000,
			},
		},
	]);
});
