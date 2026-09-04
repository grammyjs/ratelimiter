import { assertEquals } from '@std/assert';
import { limit, Limiter } from '../../../mod.ts';
import { MemoryStore } from '../../../storages.ts';
import { withFakeClock } from '../../support/fake_clock.ts';
import { createTestContext } from '../../support/context.ts';

Deno.test('refund restores one successful manual Fixed Window consumption exactly once', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user')
			.withKeyPrefix('refund:fixed'),
	);
	const ctx = createTestContext({ userId: 1 });

	const consumed = await limiter.consume(ctx);

	assertEquals(consumed.outcome, 'allowed');
	assertEquals((await limiter.inspect(ctx)).outcome, 'ready');
	assertEquals(await limiter.refund(consumed), true);
	assertEquals(await limiter.refund(consumed), false);
	assertEquals((await limiter.consume(ctx)).outcome, 'allowed');

	const exhausted = await limiter.consume(ctx);

	assertEquals(exhausted.outcome, 'throttled');
	assertEquals(await limiter.refund(exhausted), false);
	storage.close();
});

Deno.test('refund still works when a penalty folds the Fixed Window check into one round trip', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user')
			.withKeyPrefix('refund:fixed:penalty')
			.withPenalty({ penaltyTime: 30_000 }),
	);
	const ctx = createTestContext({ userId: 1 });

	const consumed = await limiter.consume(ctx);

	assertEquals(consumed.outcome, 'allowed');
	assertEquals(await limiter.refund(consumed), true);
	assertEquals(await limiter.refund(consumed), false);
	assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
	storage.close();
});

Deno.test('refund restores capacity for Sliding Window, Token Bucket, and GCRA', async () => {
	for (
		const [name, configure] of [
			[
				'sliding',
				(builder: Limiter<ReturnType<typeof createTestContext>>) =>
					builder.slidingWindow({ limit: 1, timeFrame: 60_000 }),
			],
			[
				'token',
				(builder: Limiter<ReturnType<typeof createTestContext>>) =>
					builder.tokenBucket({ bucketSize: 1, tokensPerInterval: 1, interval: 60_000 }),
			],
			[
				'gcra',
				(builder: Limiter<ReturnType<typeof createTestContext>>) =>
					builder.gcra({ rate: 1, interval: 60_000, burst: 1 }),
			],
		] as const
	) {
		const storage = new MemoryStore(null);
		const limiter = limit(
			configure(new Limiter().useStorage(storage))
				.limitFor('user')
				.withKeyPrefix(`refund:${name}`),
		);
		const ctx = createTestContext({ userId: 2 });
		const consumed = await limiter.consume(ctx);

		assertEquals(consumed.outcome, 'allowed');
		assertEquals(await limiter.refund(consumed), true);
		assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
		storage.close();
	}
});

Deno.test('Fixed Window refunds cannot credit a newer window after rollover', async () => {
	await withFakeClock(async (clock) => {
		const storage = new MemoryStore(null);
		const limiter = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 2, timeFrame: 1_000 })
				.limitFor('user')
				.withKeyPrefix('refund:fixed-rollover'),
		);
		const ctx = createTestContext({ userId: 7 });

		const oldWindow = await limiter.consume(ctx);

		assertEquals(oldWindow.outcome, 'allowed');
		clock.advance(1_001);

		assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
		assertEquals(await limiter.refund(oldWindow), false);
		assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
		assertEquals((await limiter.consume(ctx)).outcome, 'throttled');
		storage.close();
	});
});

Deno.test('refund receipts are bound to the limiter instance that produced them', async () => {
	const storage = new MemoryStore(null);
	const first = limit(
		new Limiter().useStorage(storage).fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user').withKeyPrefix('refund:first'),
	);
	const second = limit(
		new Limiter().useStorage(storage).fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user').withKeyPrefix('refund:second'),
	);
	const result = await first.consume(createTestContext({ userId: 3 }));

	assertEquals(await second.refund(result), false);
	assertEquals(await first.refund(result), true);
	storage.close();
});

Deno.test('failed awaited refunds remain retryable', async () => {
	const storage = new MemoryStore(null);
	let attempts = 0;
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.customStrategy({
				check: () => Promise.resolve({ isAllowed: true, remaining: 0, reset: 0 }),
				refund: () => {
					attempts += 1;

					if (attempts === 1) {
						return Promise.reject(new Error('temporary refund failure'));
					}

					return Promise.resolve(true);
				},
			})
			.limitFor('user')
			.withKeyPrefix('refund:retry'),
	);
	const result = await limiter.consume(createTestContext({ userId: 4 }));
	let failed = false;

	try {
		await limiter.refund(result);
	} catch {
		failed = true;
	}

	assertEquals(failed, true);
	assertEquals(await limiter.refund(result), true);
	assertEquals(attempts, 2);
	storage.close();
});

Deno.test('refundBestEffort returns immediately and contains detached refund failures', async () => {
	const storage = new MemoryStore(null);
	let resolveError!: () => void;
	const errorObserved = new Promise<void>((resolve) => {
		resolveError = resolve;
	});
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.customStrategy({
				check: () => Promise.resolve({ isAllowed: true, remaining: 0, reset: 0 }),
				refund: () => Promise.reject(new Error('detached failure')),
			})
			.limitFor('user')
			.withKeyPrefix('refund:best-effort')
			.on('refundError', (_ctx, result, error) => {
				assertEquals(result.outcome, 'allowed');
				assertEquals(
					error instanceof Error ? error.message : String(error),
					'detached failure',
				);
				resolveError();
			}),
	);
	const result = await limiter.consume(createTestContext({ userId: 5 }));

	assertEquals(limiter.refundBestEffort(result), true);
	await errorObserved;
	storage.close();
});

Deno.test('refund metrics distinguish awaited and best-effort attempts', async () => {
	const storage = new MemoryStore(null);
	const metrics: Array<import('../../../src/types.ts').LimiterMetric> = [];
	let bestEffortResolved!: () => void;
	const bestEffortDone = new Promise<void>((resolve) => {
		bestEffortResolved = resolve;
	});
	const limiter = limit(
		new Limiter()
			.withName('refund-metrics')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 60_000 })
			.limitFor('user')
			.withKeyPrefix('refund:metrics')
			.on('metric', (_ctx, metric) => {
				metrics.push(metric);

				if (metric.kind === 'refund' && metric.source === 'refund-best-effort') {
					bestEffortResolved();
				}
			}),
	);
	const ctx = createTestContext({ userId: 6 });

	const awaited = await limiter.consume(ctx);

	assertEquals(await limiter.refund(awaited), true);

	const detached = await limiter.consume(ctx);

	assertEquals(limiter.refundBestEffort(detached), true);
	await bestEffortDone;

	const refundMetrics = metrics.filter((metric) => metric.kind === 'refund');

	assertEquals(refundMetrics.length, 2);
	assertEquals(refundMetrics[0]?.source, 'refund');
	assertEquals(
		refundMetrics[0]?.kind === 'refund' ? refundMetrics[0].outcome : undefined,
		'succeeded',
	);
	assertEquals(refundMetrics[1]?.source, 'refund-best-effort');
	assertEquals(
		refundMetrics[1]?.kind === 'refund' ? refundMetrics[1].outcome : undefined,
		'succeeded',
	);
	storage.close();
});
