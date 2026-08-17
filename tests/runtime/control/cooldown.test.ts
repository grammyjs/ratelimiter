import { limit, Limiter } from '../../../mod.ts';
import { MemoryStore } from '../../../storages.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { createTestContext } from '../../support/context.ts';

Deno.test('cooldown enforces a true minimum interval between allowed actions', async () => {
	const originalNow = Date.now;
	let now = 1_000_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const limiter = limit(
			new Limiter()
				.useStorage(storage)
				.cooldown(1_000)
				.limitFor('user')
				.withKeyPrefix('cooldown:minimum-gap'),
		);
		const ctx = createTestContext({ userId: 601 });

		const first = await limiter.consume(ctx);

		assertEquals(first.outcome, 'allowed');

		if (first.outcome === 'allowed') assertEquals(first.result.reset, 1_000);

		const immediate = await limiter.consume(ctx);

		assertEquals(immediate.outcome, 'throttled');

		if (immediate.outcome === 'throttled') assertEquals(immediate.result.reset, 1_000);

		now += 999;

		const early = await limiter.consume(ctx);

		assertEquals(early.outcome, 'throttled');

		if (early.outcome === 'throttled') assertEquals(early.result.reset, 1);

		now += 1;
		assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

Deno.test('cooldown duration can be resolved from the current context', async () => {
	const originalNow = Date.now;
	let now = 2_000_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const limiter = limit(
			new Limiter()
				.useStorage(storage)
				.cooldown((ctx) => ctx.from?.id === 602 ? 500 : 1_000)
				.limitFor('user')
				.withKeyPrefix('cooldown:dynamic'),
		);
		const fast = createTestContext({ userId: 602 });
		const slow = createTestContext({ userId: 603 });

		await limiter.consume(fast);
		await limiter.consume(slow);
		now += 500;

		assertEquals((await limiter.consume(fast)).outcome, 'allowed');
		assertEquals((await limiter.consume(slow)).outcome, 'throttled');
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

Deno.test('cooldown reuses GCRA reset and refund capabilities', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.cooldown(10_000)
			.limitFor('user')
			.withKeyPrefix('cooldown:refund'),
	);
	const ctx = createTestContext({ userId: 604 });

	const consumed = await limiter.consume(ctx);

	assertEquals(consumed.outcome, 'allowed');
	assertEquals(await limiter.refund(consumed), true);
	assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
	assertEquals(await limiter.reset(ctx), true);
	assertEquals((await limiter.consume(ctx)).outcome, 'allowed');
	storage.close();
});

Deno.test('cooldown validates static durations eagerly', () => {
	assertThrows(() => new Limiter().cooldown(0), Error, 'positive integer');
	assertThrows(() => new Limiter().cooldown(1.5), Error, 'positive integer');
});
