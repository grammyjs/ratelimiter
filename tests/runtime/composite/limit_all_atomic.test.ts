import { Limiter } from '../../../src/core/builder.ts';
import { createNextSpy } from '../../support/next_spy.ts';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { createTestContext } from '../../support/context.ts';
import { limitAllAtomic } from '../../../src/core/atomic_composite.ts';
import { assertEquals, assertRejects, assertThrows } from '@std/assert';

import type {
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	ILimiterStrategy,
	IStorageEngine,
	LimitResult,
} from '../../../src/types.ts';

function fixedLayer(
	storage: IStorageEngine,
	prefix: string,
	limit = 1,
	scope: 'user' | 'global' = 'user',
) {
	return new Limiter()
		.withKeyPrefix(prefix)
		.useStorage(storage)
		.fixedWindow({ limit, timeFrame: 1_000 })
		.limitFor(scope);
}

Deno.test('limitAllAtomic commits all layers together when every layer allows', async () => {
	const storage = new MemoryStore(null);
	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:user', 2),
		fixedLayer(storage, 'atomic:global', 2, 'global'),
	);

	await middleware(createTestContext({ userId: 42 }), next.next);

	assertEquals(next.calls, 1);
	assertEquals(await storage.get<number>('atomic:user:42'), 1);
	assertEquals(await storage.get<number>('atomic:global:___GLOBAL___'), 1);
	storage.close();
});

Deno.test('limitAllAtomic does not consume earlier capacity when a later layer throttles', async () => {
	const storage = new MemoryStore(null);

	await storage.increment('atomic:global:___GLOBAL___', 1_000);

	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:user'),
		fixedLayer(storage, 'atomic:global', 1, 'global'),
	);

	await middleware(createTestContext({ userId: 42 }), next.next);

	assertEquals(next.calls, 0);
	assertEquals(await storage.get<number>('atomic:user:42'), undefined);
	assertEquals(await storage.get<number>('atomic:global:___GLOBAL___'), 1);
	storage.close();
});

Deno.test('limitAllAtomic does not consume capacity before a later active penalty', async () => {
	const storage = new MemoryStore(null);

	await storage.setPenalty('atomic:global:PENALTY:___GLOBAL___', 1_000);

	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:user'),
		fixedLayer(storage, 'atomic:global', 1, 'global').withPenalty({ penaltyTime: 500 }),
	);

	await middleware(createTestContext({ userId: 42 }), next.next);

	assertEquals(next.calls, 0);
	assertEquals(await storage.get<number>('atomic:user:42'), undefined);
	storage.close();
});

Deno.test('limitAllAtomic keeps filters and missing keys as true bypasses', async () => {
	const storage = new MemoryStore(null);
	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:bypass').onlyIf(() => false),
		new Limiter()
			.withKeyPrefix('atomic:missing')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor(() => undefined),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(await storage.get<number>('atomic:bypass:100'), undefined);
	storage.close();
});

Deno.test('limitAllAtomic requires one shared atomic-capable storage instance', () => {
	const first = new MemoryStore(null);
	const second = new MemoryStore(null);

	try {
		assertThrows(
			() => limitAllAtomic(fixedLayer(first, 'first'), fixedLayer(second, 'second')),
			Error,
			'exact same storage instance',
		);
	} finally {
		first.close();
		second.close();
	}
});

Deno.test('limitAllAtomic rejects observe-only layers explicitly', () => {
	const storage = new MemoryStore(null);

	try {
		assertThrows(
			() => limitAllAtomic(fixedLayer(storage, 'observe').observeOnly()),
			Error,
			'observe-only rules cannot participate',
		);
	} finally {
		storage.close();
	}
});

Deno.test('limitAllAtomic rejects custom strategies without an atomic descriptor', async () => {
	const storage = new MemoryStore(null);
	const strategy: ILimiterStrategy = {
		check: (_key: string, _storage: IStorageEngine): Promise<LimitResult> =>
			Promise.resolve({ isAllowed: true, remaining: 1, reset: 0 }),
	};
	const middleware = limitAllAtomic(
		new Limiter()
			.withKeyPrefix('custom')
			.useStorage(storage)
			.customStrategy(strategy)
			.limitFor('user'),
	);

	try {
		await assertRejects(
			async () => {
				await middleware(createTestContext(), async () => {});
			},
			Error,
			'does not expose toAtomicOperation',
		);
	} finally {
		storage.close();
	}
});

Deno.test('limitAllAtomic applies throttling callbacks and penalties only to the rejecting layer', async () => {
	const storage = new MemoryStore(null);

	await storage.increment('atomic:reject:___GLOBAL___', 1_000);

	let firstThrottled = 0;
	let secondThrottled = 0;
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:first').onThrottled(() => {
			firstThrottled += 1;
		}),
		fixedLayer(storage, 'atomic:reject', 1, 'global')
			.onThrottled(() => {
				secondThrottled += 1;
			})
			.withPenalty({ penaltyTime: 500 }),
	);

	await middleware(createTestContext(), async () => {});

	assertEquals(firstThrottled, 0);
	assertEquals(secondThrottled, 1);
	assertEquals(await storage.checkPenalty('atomic:reject:PENALTY:___GLOBAL___'), true);
	storage.close();
});

class FailingAtomicStore extends MemoryStore {
	public override consumeAtomicLimit(
		_layers: readonly AtomicLimitLayerInput[],
	): Promise<AtomicLimitConsumeResult> {
		return Promise.reject(new Error('atomic backend unavailable'));
	}
}

Deno.test('limitAllAtomic allows downstream only when every storage-failure policy fails open', async () => {
	const storage = new FailingAtomicStore(null);
	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'failure:first').withStorageFailurePolicy('fail-open'),
		fixedLayer(storage, 'failure:second').withStorageFailurePolicy('fail-open'),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	storage.close();
});

Deno.test('limitAllAtomic uses fail-closed when any layer requires it', async () => {
	const storage = new FailingAtomicStore(null);
	const next = createNextSpy();
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'failure:first').withStorageFailurePolicy('fail-open'),
		fixedLayer(storage, 'failure:second').withStorageFailurePolicy('fail-closed'),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 0);
	storage.close();
});

Deno.test('limitAllAtomic preserves each rule name in structured decisions', async () => {
	const storage = new MemoryStore(null);
	const names: Array<string | undefined> = [];
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:named:first', 2)
			.withName('user-layer')
			.on('decision', (_ctx, decision) => names.push(decision.ruleName)),
		fixedLayer(storage, 'atomic:named:second', 2, 'global')
			.withName('global-layer')
			.on('decision', (_ctx, decision) => names.push(decision.ruleName)),
	);

	await middleware(createTestContext(), () => Promise.resolve());

	assertEquals(names, ['user-layer', 'global-layer']);
	storage.close();
});

Deno.test('limitAllAtomic preserves opt-in rich metadata for each rule decision', async () => {
	type MetadataContext = ReturnType<typeof createTestContext> & { tenantId: string };

	const storage = new MemoryStore(null);
	const metadata: unknown[] = [];
	const middleware = limitAllAtomic(
		new Limiter<MetadataContext>()
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId, layer: 'user' as const }))
			.withName('atomic-metadata-user')
			.withKeyPrefix('atomic:metadata:user')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user')
			.on('decision', (_ctx, decision) => metadata.push(decision.metadata)),
		new Limiter<MetadataContext>()
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId, layer: 'global' as const }))
			.withName('atomic-metadata-global')
			.withKeyPrefix('atomic:metadata:global')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('global')
			.on('decision', (_ctx, decision) => metadata.push(decision.metadata)),
	);
	const ctx = Object.assign(createTestContext({ userId: 88, chatId: 99 }), {
		tenantId: 'acme',
	}) as MetadataContext;

	await middleware(ctx, () => Promise.resolve());

	assertEquals(metadata, [
		{ userId: 88, chatId: 99, custom: { tenantId: 'acme', layer: 'user' } },
		{ userId: 88, chatId: 99, custom: { tenantId: 'acme', layer: 'global' } },
	]);
	storage.close();
});

Deno.test('limitAllAtomic diagnostics report a known blocking layer even after an uncertain custom layer', async () => {
	const storage = new MemoryStore(null);
	const unknown = new Limiter()
		.withName('custom')
		.useStorage(storage)
		.customStrategy({
			check: () => Promise.resolve({ isAllowed: true, remaining: 0, reset: 0 }),
			toAtomicOperation: (key) => ({
				kind: 'fixed-window',
				key,
				limit: 100,
				timeFrame: 10_000,
			}),
		})
		.limitFor('user')
		.withKeyPrefix('diagnose:atomic:custom');
	const blocker = new Limiter()
		.withName('global')
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.limitFor('global')
		.withKeyPrefix('diagnose:atomic:global');
	const middleware = limitAllAtomic(unknown, blocker);
	const ctx = createTestContext({ userId: 91 });

	await storage.increment('diagnose:atomic:global:___GLOBAL___', 10_000);

	const diagnostic = await middleware.diagnose(ctx);

	assertEquals(diagnostic.outcome, 'would-block');

	if (diagnostic.outcome !== 'would-block') {
		throw new Error('expected blocking atomic diagnostic');
	}

	assertEquals(diagnostic.blockingLayer, 1);
	assertEquals(diagnostic.layers[0]?.diagnostic.outcome, 'unknown');
	assertEquals(diagnostic.layers[1]?.diagnostic.ruleName, 'global');
	storage.close();
});

Deno.test('limitAllAtomic emits decision metrics with atomic-composite source', async () => {
	const storage = new MemoryStore(null);
	const sources: string[] = [];
	const middleware = limitAllAtomic(
		fixedLayer(storage, 'atomic:metrics:first', 2)
			.withName('first')
			.on('metric', (_ctx, metric) => sources.push(metric.source)),
		fixedLayer(storage, 'atomic:metrics:second', 2, 'global')
			.withName('second')
			.on('metric', (_ctx, metric) => sources.push(metric.source)),
	);

	await middleware(createTestContext(), () => Promise.resolve());
	assertEquals(sources, ['atomic-composite', 'atomic-composite']);
	storage.close();
});
