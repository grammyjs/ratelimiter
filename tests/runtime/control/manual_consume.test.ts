import { assertEquals } from '@std/assert';
import { limit, Limiter } from '../../../mod.ts';
import { MemoryStore } from '../../../storages.ts';
import { createTestContext } from '../../support/context.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';

Deno.test('consume enforces one rule without invoking grammY downstream middleware', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:fixed'),
	);
	const ctx = createTestContext({ userId: 41 });

	const first = await limiter.consume(ctx);
	const second = await limiter.consume(ctx);

	assertEquals(first.isAllowed, true);
	assertEquals(first.outcome, 'allowed');
	assertEquals(second.isAllowed, false);
	assertEquals(second.outcome, 'throttled');

	if (second.outcome === 'throttled') {
		assertEquals(second.result.isAllowed, false);
	}
});

Deno.test('consume returns bypasses as allowed without touching capacity', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:bypass')
			.onlyIf(() => false),
	);
	const ctx = createTestContext({ userId: 42 });

	assertEquals(await limiter.consume(ctx), {
		isAllowed: true,
		outcome: 'bypassed',
		mode: 'enforce',
		reason: 'filter',
	});

	const inspection = await limiter.inspect(ctx);

	assertEquals(inspection.outcome, 'bypassed');
});

Deno.test('consume preserves named rich metadata in the returned decision', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:metadata')
			.withName('manual-generation')
			.withMetadata((ctx) => ({ tenantId: `tenant:${ctx.chat?.id}` })),
	);
	const ctx = createTestContext({ userId: 43, chatId: -10043 });

	const result = await limiter.consume(ctx);

	assertEquals(result.ruleName, 'manual-generation');
	assertEquals(result.metadata, {
		userId: 43,
		chatId: -10043,
		custom: { tenantId: 'tenant:-10043' },
	});
});

Deno.test('consume reports observe-only throttles as non-blocking while advancing shadow state', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:observe')
			.observeOnly(),
	);
	const ctx = createTestContext({ userId: 44 });

	assertEquals((await limiter.consume(ctx)).outcome, 'allowed');

	const throttled = await limiter.consume(ctx);

	assertEquals(throttled.outcome, 'throttled');
	assertEquals(throttled.isAllowed, true);
});

Deno.test('consume applies penalties and escalation through the normal enforcement path', async () => {
	const storage = new MemoryStore(null);
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:penalty')
			.withPenalty({
				penaltyTime: 1_000,
				escalation: { factor: 2, maxPenaltyTime: 8_000, resetAfter: 60_000 },
			}),
	);
	const ctx = createTestContext({ userId: 45 });

	await limiter.consume(ctx);

	const throttled = await limiter.consume(ctx);

	assertEquals(throttled.isAllowed, false);
	assertEquals(throttled.outcome, 'throttled');

	const penaltyHit = await limiter.consume(ctx);

	assertEquals(penaltyHit.isAllowed, false);
	assertEquals(penaltyHit.outcome, 'penalty-hit');

	const inspection = await limiter.inspect(ctx);

	if (inspection.outcome !== 'ready' || !inspection.penalty.configured) {
		throw new Error('expected configured penalty state');
	}

	assertEquals(inspection.penalty.active, true);

	if (!inspection.penalty.escalation.configured || !inspection.penalty.escalation.supported) {
		throw new Error('expected inspectable escalation state');
	}

	assertEquals(inspection.penalty.escalation.strikes, 1);
});

Deno.test('consume preserves throttling callbacks and decision events', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 2, reset: 9_000 });

	let callbacks = 0;
	const decisions: string[] = [];
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:events')
			.onThrottled(() => {
				callbacks += 1;
			})
			.on('decision', (_ctx, decision) => {
				decisions.push(decision.outcome);
			}),
	);

	const result = await limiter.consume(createTestContext({ userId: 46 }));

	assertEquals(result.isAllowed, false);
	assertEquals(result.outcome, 'throttled');
	assertEquals(callbacks, 1);
	assertEquals(decisions, ['throttled']);
});

Deno.test('consume maps storage failure policy to caller control flow', async () => {
	const openStorage = new ScriptedStorage();

	openStorage.failures.set('increment', new Error('redis unavailable'));

	const failOpen = limit(
		new Limiter()
			.useStorage(openStorage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withKeyPrefix('manual:fail-open')
			.withStorageFailurePolicy('fail-open'),
	);
	const openResult = await failOpen.consume(createTestContext({ userId: 47 }));

	assertEquals(openResult.isAllowed, true);
	assertEquals(openResult.outcome, 'storage-failure');

	if (openResult.outcome === 'storage-failure') {
		assertEquals(openResult.resolution, 'fail-open');
	}

	const closedStorage = new ScriptedStorage();

	closedStorage.failures.set('increment', new Error('redis unavailable'));

	const failClosed = limit(
		new Limiter()
			.useStorage(closedStorage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withKeyPrefix('manual:fail-closed')
			.withStorageFailurePolicy('fail-closed'),
	);
	const closedResult = await failClosed.consume(createTestContext({ userId: 48 }));

	assertEquals(closedResult.isAllowed, false);
	assertEquals(closedResult.outcome, 'storage-failure');

	if (closedResult.outcome === 'storage-failure') {
		assertEquals(closedResult.resolution, 'fail-closed');
	}
});

Deno.test('consume resolves enabled metadata while ordinary middleware keeps it lazy', async () => {
	const storage = new MemoryStore(null);
	let resolutions = 0;
	const limiter = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 3, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('manual:metadata-lazy')
			.withMetadata(() => {
				resolutions += 1;

				return { source: 'manual' as const };
			}),
	);
	const ctx = createTestContext({ userId: 49 });

	await limiter(ctx, async () => {});
	assertEquals(resolutions, 0);

	const result = await limiter.consume(ctx);

	assertEquals(resolutions, 1);
	assertEquals(result.metadata.custom?.source, 'manual');
});
