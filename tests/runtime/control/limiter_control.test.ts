import { assertEquals } from '@std/assert';
import { limit, Limiter } from '../../../mod.ts';
import { MemoryStore } from '../../../storages.ts';
import { withFakeClock } from '../../support/fake_clock.ts';
import { createTestContext } from '../../support/context.ts';

Deno.test('inspect previews the next decision without consuming Fixed Window capacity', async () => {
	await withFakeClock(async () => {
		const storage = new MemoryStore(null);
		const controlled = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 2, timeFrame: 1_000 })
				.limitFor('user')
				.withKeyPrefix('control:fixed'),
		);
		const ctx = createTestContext({ userId: 7 });

		await controlled(ctx, async () => {});

		const first = await controlled.inspect(ctx);
		const second = await controlled.inspect(ctx);

		assertEquals(first, second);

		if (first.outcome !== 'ready' || !first.strategy.supported) {
			throw new Error('expected inspectable limiter state');
		}

		assertEquals(first.strategy.result, { isAllowed: true, remaining: 0, reset: 1_000 });

		await controlled(ctx, async () => {});

		const afterConsume = await controlled.inspect(ctx);

		if (afterConsume.outcome !== 'ready' || !afterConsume.strategy.supported) {
			throw new Error('expected inspectable limiter state');
		}

		assertEquals(afterConsume.strategy.result.isAllowed, false);
	});
});

Deno.test('reset clears strategy state without clearing penalty state', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('control:reset')
			.withPenalty({ penaltyTime: 5_000 }),
	);
	const ctx = createTestContext({ userId: 8 });

	await controlled(ctx, async () => {});
	await controlled(ctx, async () => {});
	assertEquals(await controlled.reset(ctx), true);

	const inspection = await controlled.inspect(ctx);

	if (inspection.outcome !== 'ready' || !inspection.strategy.supported) {
		throw new Error('expected inspectable limiter state');
	}

	assertEquals(inspection.strategy.result.isAllowed, true);
	assertEquals(inspection.penalty.configured, true);

	if (inspection.penalty.configured) {
		assertEquals(inspection.penalty.active, true);
	}
});

Deno.test('clearPenalty clears only the penalty marker', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('control:penalty')
			.withPenalty({ penaltyTime: 5_000 }),
	);
	const ctx = createTestContext({ userId: 9 });

	await controlled(ctx, async () => {});
	await controlled(ctx, async () => {});
	assertEquals(await controlled.clearPenalty(ctx), true);
	assertEquals(await controlled.clearStrikes(ctx), false);

	const inspection = await controlled.inspect(ctx);

	if (inspection.outcome !== 'ready' || !inspection.strategy.supported) {
		throw new Error('expected inspectable limiter state');
	}

	assertEquals(inspection.strategy.result.isAllowed, false);
	assertEquals(inspection.penalty.configured, true);

	if (inspection.penalty.configured) {
		assertEquals(inspection.penalty.active, false);
		assertEquals(inspection.penalty.expiresIn, undefined);
	}
});

Deno.test('inspect reports bypasses and unsupported custom strategy previews explicitly', async () => {
	const storage = new MemoryStore(null);
	const filtered = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withKeyPrefix('control:filter')
			.onlyIf(() => false),
	);

	assertEquals(await filtered.inspect(createTestContext()), {
		outcome: 'bypassed',
		mode: 'enforce',
		reason: 'filter',
	});

	const custom = limit(
		new Limiter()
			.useStorage(storage)
			.customStrategy({
				check: () => Promise.resolve({ isAllowed: true, remaining: 0, reset: 0 }),
			})
			.limitFor('user')
			.withKeyPrefix('control:custom'),
	);
	const customContext = createTestContext();
	const inspection = await custom.inspect(customContext);

	if (inspection.outcome !== 'ready') {
		throw new Error('expected ready inspection');
	}

	assertEquals(inspection.strategy, { supported: false });
	assertEquals(await custom.reset(customContext), false);
});

Deno.test('reset ignores onlyIf when an entity key can still be resolved', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('control:filter-reset')
			.onlyIf((ctx) => ctx.message?.text === 'limited'),
	);
	const limited = createTestContext({ userId: 10, text: 'limited' });
	const bypassed = createTestContext({ userId: 10, text: 'admin' });

	await controlled(limited, async () => {});
	assertEquals((await controlled.inspect(limited)).outcome, 'ready');
	assertEquals(await controlled.reset(bypassed), true);

	const afterReset = await controlled.inspect(limited);

	if (afterReset.outcome !== 'ready' || !afterReset.strategy.supported) {
		throw new Error('expected inspectable limiter state');
	}

	assertEquals(afterReset.strategy.result.isAllowed, true);
});

Deno.test('reset does not resolve dynamic strategy configuration', async () => {
	const storage = new MemoryStore(null);

	type DynamicContext = ReturnType<typeof createTestContext> & { requestLimit: number };

	const controlled = limit(
		new Limiter<DynamicContext>()
			.useStorage(storage)
			.fixedWindow({ limit: (ctx) => ctx.requestLimit, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('control:dynamic-reset'),
	);
	const ctx = Object.assign(createTestContext({ userId: 11 }), { requestLimit: 1 });

	await controlled(ctx, async () => {});
	ctx.requestLimit = 0; // invalid if a reset unnecessarily resolves the strategy
	assertEquals(await controlled.reset(ctx), true);
});

Deno.test('reset and clearPenalty ignore onlyIf but respect unresolved entity keys', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor(() => undefined)
			.withKeyPrefix('control:missing')
			.withPenalty({ penaltyTime: 1_000 })
			.onlyIf(() => false),
	);
	const ctx = createTestContext();

	assertEquals(await controlled.reset(ctx), false);
	assertEquals(await controlled.clearPenalty(ctx), false);
	assertEquals(await controlled.clearStrikes(ctx), false);
});

Deno.test('inspect returns enabled rich metadata without mutating limiter state', async () => {
	type MetadataContext = ReturnType<typeof createTestContext> & { tenantId: string };

	const storage = new MemoryStore(null);
	const middleware = limit(
		new Limiter<MetadataContext>()
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId }))
			.withKeyPrefix('controls:metadata')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user'),
	);
	const ctx = Object.assign(createTestContext({ userId: 55, chatId: 77 }), {
		tenantId: 'tenant-1',
	}) as MetadataContext;

	const inspection = await middleware.inspect(ctx);

	assertEquals(inspection.metadata, {
		userId: 55,
		chatId: 77,
		custom: { tenantId: 'tenant-1' },
	});
	storage.close();
});

Deno.test('diagnose explains limiter state without consuming capacity or emitting events', async () => {
	await withFakeClock(async () => {
		const storage = new MemoryStore(null);
		let decisionEvents = 0;
		const controlled = limit(
			new Limiter()
				.withName('diagnostic-rule')
				.withMetadata()
				.useStorage(storage)
				.fixedWindow({ limit: 1, timeFrame: 1_000 })
				.limitFor('user')
				.withKeyPrefix('control:diagnose')
				.on('decision', () => {
					decisionEvents += 1;
				}),
		);
		const ctx = createTestContext({ userId: 42, chatId: 99 });

		const first = await controlled.diagnose(ctx);

		assertEquals(first.outcome, 'would-allow');
		assertEquals(first.wouldContinue, true);
		assertEquals(first.ruleName, 'diagnostic-rule');
		assertEquals(first.metadata, { userId: 42, chatId: 99 });
		assertEquals(first.storageFailurePolicy, { kind: 'static', mode: 'throw' });

		if (first.outcome !== 'would-allow') throw new Error('expected an allow diagnostic');

		assertEquals(first.strategy.kind, 'fixed-window');
		assertEquals(first.strategy.options, { limit: 1, timeFrame: 1_000 });
		assertEquals(decisionEvents, 0);

		await controlled(ctx, async () => {});

		const second = await controlled.diagnose(ctx);

		assertEquals(second.outcome, 'would-throttle');
		assertEquals(second.wouldContinue, false);
		assertEquals(decisionEvents, 1, 'diagnostics must not emit decision events');
	});
});

Deno.test('diagnose reports bypasses, active penalties, observe outcomes, and unsupported previews', async () => {
	const storage = new MemoryStore(null);
	const ctx = createTestContext({ userId: 77 });

	const filtered = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withKeyPrefix('diagnose:filtered')
			.onlyIf(() => false),
	);

	assertEquals(await filtered.diagnose(ctx), {
		outcome: 'bypassed',
		mode: 'enforce',
		wouldContinue: true,
		reason: 'filter',
		storageFailurePolicy: { kind: 'static', mode: 'throw' },
	});

	const penalized = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('diagnose:penalty')
			.withPenalty({ penaltyTime: 10_000 }),
	);

	await penalized(ctx, async () => {});
	await penalized(ctx, async () => {});

	const penaltyDiagnostic = await penalized.diagnose(ctx);

	assertEquals(penaltyDiagnostic.outcome, 'penalty-hit');
	assertEquals(penaltyDiagnostic.wouldContinue, false);

	const observed = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('diagnose:observe')
			.observeOnly(),
	);

	await observed(ctx, async () => {});

	const observedDiagnostic = await observed.diagnose(ctx);

	assertEquals(observedDiagnostic.outcome, 'would-throttle');
	assertEquals(observedDiagnostic.wouldContinue, true);

	const custom = limit(
		new Limiter()
			.useStorage(storage)
			.customStrategy({
				check: () => Promise.resolve({ isAllowed: true, remaining: 0, reset: 0 }),
			})
			.limitFor('user')
			.withKeyPrefix('diagnose:custom')
			.withStorageFailurePolicy((): 'fail-open' => 'fail-open'),
	);
	const customDiagnostic = await custom.diagnose(ctx);

	assertEquals(customDiagnostic.outcome, 'unknown');
	assertEquals(customDiagnostic.wouldContinue, undefined);
	assertEquals(customDiagnostic.storageFailurePolicy, { kind: 'dynamic' });

	if (customDiagnostic.outcome !== 'unknown') throw new Error('expected unknown diagnostic');

	assertEquals(customDiagnostic.strategy.kind, 'custom');

	storage.close();
});
