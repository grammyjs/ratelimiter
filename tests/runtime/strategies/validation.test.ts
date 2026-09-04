import { assertEquals, assertThrows } from '@std/assert';
import { GcraStrategy } from '../../../src/strategies/gcra.ts';
import { FixedWindowStrategy } from '../../../src/strategies/fixed_window.ts';
import { TokenBucketStrategy } from '../../../src/strategies/token_bucket.ts';
import { SlidingWindowStrategy } from '../../../src/strategies/sliding_window.ts';

Deno.test('built-in strategies validate configuration and snapshot caller-owned options', () => {
	assertThrows(
		() => new FixedWindowStrategy({ limit: 0, timeFrame: 1_000 }),
		Error,
		'positive integers',
	);
	assertThrows(
		() => new FixedWindowStrategy({ limit: 1, timeFrame: Number.NaN }),
		Error,
		'positive integers',
	);
	assertThrows(
		() => new TokenBucketStrategy({ bucketSize: 0.5, tokensPerInterval: 1, interval: 1_000 }),
		Error,
		'bucketSize must be at least 1',
	);

	const fixedOptions = { limit: 2, timeFrame: 1_000 };
	const fixed = new FixedWindowStrategy(fixedOptions);

	fixedOptions.limit = 99;
	assertEquals(fixed.options.limit, 2);

	const slidingOptions = { limit: 5, timeFrame: 1_000, cost: 2 };
	const sliding = new SlidingWindowStrategy(slidingOptions);

	slidingOptions.limit = 99;
	assertEquals(sliding.options.limit, 5);

	const gcraOptions = { rate: 2, interval: 1_000, burst: 3 };
	const gcra = new GcraStrategy(gcraOptions);

	gcraOptions.burst = 99;
	assertEquals(gcra.options.burst, 3);

	const bucketOptions = { bucketSize: 3, tokensPerInterval: 1, interval: 1_000 };
	const bucket = new TokenBucketStrategy(bucketOptions);

	bucketOptions.bucketSize = 99;
	assertEquals(bucket.options.bucketSize, 3);
});

Deno.test('TokenBucketStrategy rejects impossible weighted costs', () => {
	assertThrows(
		() =>
			new TokenBucketStrategy({
				bucketSize: 2,
				tokensPerInterval: 1,
				interval: 1_000,
				cost: 3,
			}),
		Error,
		'cost must not exceed bucketSize',
	);

	assertThrows(
		() =>
			new TokenBucketStrategy({
				bucketSize: 2,
				tokensPerInterval: 1,
				interval: 1_000,
				cost: 0,
			}),
		Error,
		'cost must be finite positive',
	);
});

Deno.test('GcraStrategy rejects invalid rates, bursts, intervals, and costs', () => {
	assertThrows(
		() => new GcraStrategy({ rate: 0, interval: 1_000, burst: 1 }),
		Error,
		'rate, burst, and cost must be finite positive',
	);
	assertThrows(
		() => new GcraStrategy({ rate: 1, interval: 1.5, burst: 1 }),
		Error,
		'interval must be a positive integer',
	);
	assertThrows(
		() => new GcraStrategy({ rate: 1, interval: 1_000, burst: 2, cost: 3 }),
		Error,
		'cost must not exceed burst',
	);
});

Deno.test('SlidingWindowStrategy rejects invalid limits, windows, and costs', () => {
	assertThrows(
		() => new SlidingWindowStrategy({ limit: 0, timeFrame: 1_000 }),
		Error,
		'limit and cost must be finite positive',
	);
	assertThrows(
		() => new SlidingWindowStrategy({ limit: 5, timeFrame: 1.5 }),
		Error,
		'timeFrame must be a positive integer',
	);
	assertThrows(
		() => new SlidingWindowStrategy({ limit: 2, timeFrame: 1_000, cost: 3 }),
		Error,
		'cost must not exceed limit',
	);
});
