import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { assertEquals, assertRejects } from '@std/assert';
import { createNextSpy } from '../../support/next_spy.ts';
import { createTestContext } from '../../support/context.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';

const createLimiter = () => new Limiter().withKeyPrefix('middleware');

Deno.test('middleware fully bypasses storage when onlyIf returns false', async () => {
	const storage = new ScriptedStorage();
	const next = createNextSpy();
	const bypasses: string[] = [];
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.onlyIf(() => false)
			.on('bypassed', (_ctx, info) => bypasses.push(info.reason))
			.withPenalty({ penaltyTime: 1_000 }),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(storage.penaltyChecks, []);
	assertEquals(storage.incrementCalls, []);
	assertEquals(bypasses, ['filter']);
});

Deno.test('middleware fully bypasses storage when a custom key generator returns undefined', async () => {
	const storage = new ScriptedStorage();
	const next = createNextSpy();
	const bypasses: string[] = [];
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor(() => undefined)
			.on('bypassed', (_ctx, info) => bypasses.push(info.reason))
			.withPenalty({ penaltyTime: 1_000 }),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(storage.penaltyChecks, []);
	assertEquals(storage.incrementCalls, []);
	assertEquals(bypasses, ['missing-key']);
});

Deno.test('middleware checks an active penalty before strategy evaluation', async () => {
	const storage = new ScriptedStorage();

	storage.activePenalties.add('middleware:PENALTY:100');

	const next = createNextSpy();
	const penaltyHits: string[] = [];
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 1_000 })
			.on('penaltyHit', (_ctx, entityKey) => penaltyHits.push(entityKey)),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);

	assertEquals(next.calls, 0);
	assertEquals(storage.penaltyChecks, ['middleware:PENALTY:100']);
	assertEquals(storage.incrementCalls, []);
	assertEquals(penaltyHits, ['100']);
});

Deno.test('default penalty namespaces stay isolated by rule key prefix', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 2, reset: 1_000 },
		{ value: 1, reset: 1_000 },
	);

	const firstNext = createNextSpy();
	const secondNext = createNextSpy();
	const first = limit(
		new Limiter()
			.withKeyPrefix('penalty-isolation:first')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 10_000 }),
	);
	const second = limit(
		new Limiter()
			.withKeyPrefix('penalty-isolation:second')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 10_000 }),
	);

	const ctx = createTestContext({ userId: 100 });

	await first(ctx, firstNext.next);
	await second(ctx, secondNext.next);

	assertEquals(firstNext.calls, 0);
	assertEquals(secondNext.calls, 1);
	assertEquals(storage.penaltyChecks, [
		'penalty-isolation:first:PENALTY:100',
		'penalty-isolation:second:PENALTY:100',
	]);
	assertEquals(storage.penaltyWrites, [
		{ key: 'penalty-isolation:first:PENALTY:100', ttl: 10_000 },
	]);
	assertEquals(storage.incrementCalls, [
		{ key: 'penalty-isolation:first:100', ttl: 1_000 },
		{ key: 'penalty-isolation:second:100', ttl: 1_000 },
	]);
});

Deno.test('middleware derives stable keys for user, chat, and global scopes', async () => {
	for (
		const [scope, expectedKey] of [
			['user', 'scope:101'],
			['chat', 'scope:202'],
			['global', 'scope:___GLOBAL___'],
		] as const
	) {
		const storage = new ScriptedStorage();

		storage.incrementResults.push({ value: 1, reset: 1_000 });

		const middleware = limit(
			new Limiter()
				.withKeyPrefix('scope')
				.useStorage(storage)
				.fixedWindow({ limit: 1, timeFrame: 1_000 })
				.limitFor(scope),
		);

		await middleware(
			createTestContext({ userId: 101, chatId: 202 }),
			() => Promise.resolve(),
		);

		assertEquals(storage.incrementCalls, [{ key: expectedKey, ttl: 1_000 }]);
	}
});

Deno.test('middleware emits allowed before calling downstream middleware', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 1, reset: 900 });

	const order: string[] = [];
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user')
			.on('allowed', (_ctx, info) => {
				order.push(`allowed:${info.remaining}`);
			}),
	);

	await middleware(createTestContext(), () => {
		order.push('next');

		return Promise.resolve();
	});

	assertEquals(order, ['allowed:1', 'next']);
});

Deno.test('middleware awaits onThrottled before persisting and emitting a penalty', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 2, reset: 750 });

	const order: string[] = [];
	let releaseHandler!: () => void;
	let markHandlerStarted!: () => void;
	const handlerGate = new Promise<void>((resolve) => {
		releaseHandler = resolve;
	});
	const handlerStarted = new Promise<void>((resolve) => {
		markHandlerStarted = resolve;
	});

	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.on('throttled', () => order.push('throttled-event'))
			.onThrottled(async () => {
				order.push('handler-start');
				markHandlerStarted();
				await handlerGate;
				order.push('handler-end');
			})
			.withPenalty({
				penaltyTime: (_ctx, info) => info.reset + 0.25,
			})
			.on('penaltyApplied', (_ctx, _key, duration) => {
				order.push(`penalty-event:${duration}`);
			}),
	);

	const pending = middleware(createTestContext({ userId: 100 }), () => Promise.resolve());

	await handlerStarted;

	assertEquals(order, ['throttled-event', 'handler-start']);
	assertEquals(storage.penaltyWrites, []);

	releaseHandler();
	await pending;

	assertEquals(storage.penaltyWrites, [
		{ key: 'middleware:PENALTY:100', ttl: 751 },
	]);
	assertEquals(order, [
		'throttled-event',
		'handler-start',
		'handler-end',
		'penalty-event:751',
	]);
});

Deno.test('middleware applies dynamic Fixed Window limits per context', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 900 },
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 900 },
	);

	const next = createNextSpy();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({
				limit: (ctx) => ctx.from?.id === 200 ? 2 : 1,
				timeFrame: 1_000,
			})
			.limitFor('user'),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 200 }), next.next);
	await middleware(createTestContext({ userId: 200 }), next.next);

	assertEquals(next.calls, 3);
});

Deno.test('replacing a dynamic Fixed Window with a numeric one clears the old generator', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 900 },
	);

	const next = createNextSpy();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: () => 1, timeFrame: 1_000 })
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user'),
	);

	await middleware(createTestContext(), next.next);
	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 2);
});

Deno.test('event listener exceptions propagate through middleware', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 1, reset: 1_000 });

	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.on('allowed', () => {
				throw new Error('observer failed');
			}),
	);

	await assertRejects(
		async () => {
			await middleware(createTestContext(), () => Promise.resolve());
		},
		Error,
		'observer failed',
	);
});

Deno.test('middleware resolves dynamic Token Bucket configuration and request cost per context', async () => {
	const storage = new ScriptedStorage();

	storage.tokenBucketResults.push(
		{ isAllowed: true, tokens: 2, reset: 0 },
		{ isAllowed: true, tokens: 6, reset: 0 },
	);

	const next = createNextSpy();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.tokenBucket({
				bucketSize: (ctx) => ctx.from?.id === 200 ? 12 : 4,
				tokensPerInterval: (ctx) => ctx.from?.id === 200 ? 3 : 1,
				interval: 1_000,
				cost: (ctx) => ctx.from?.id === 200 ? 3 : 2,
			})
			.limitFor('user'),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 200 }), next.next);

	assertEquals(next.calls, 2);
	assertEquals(storage.consumeTokenBucketCalls, [
		{
			key: 'middleware:100',
			options: {
				bucketSize: 4,
				tokensPerInterval: 1,
				interval: 1_000,
				cost: 2,
				ttl: 4_000,
			},
		},
		{
			key: 'middleware:200',
			options: {
				bucketSize: 12,
				tokensPerInterval: 3,
				interval: 1_000,
				cost: 3,
				ttl: 4_000,
			},
		},
	]);
});

Deno.test('middleware rejects invalid context-derived Token Bucket configuration before storage', async () => {
	const storage = new ScriptedStorage();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.tokenBucket({
				bucketSize: 2,
				tokensPerInterval: 1,
				interval: 1_000,
				cost: (ctx) => ctx.from?.id === 100 ? 3 : 1,
			})
			.limitFor('user'),
	);

	await assertRejects(
		async () => {
			await middleware(createTestContext({ userId: 100 }), () => Promise.resolve());
		},
		Error,
		'cost must not exceed bucketSize',
	);
	assertEquals(storage.consumeTokenBucketCalls, []);
});

Deno.test('middleware resolves dynamic GCRA configuration and request cost per context', async () => {
	const storage = new ScriptedStorage();

	storage.gcraResults.push(
		{ isAllowed: true, remaining: 1, reset: 0 },
		{ isAllowed: true, remaining: 2, reset: 0 },
	);

	const next = createNextSpy();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.gcra({
				rate: (ctx) => ctx.from?.id === 200 ? 8 : 2,
				interval: 1_000,
				burst: (ctx) => ctx.from?.id === 200 ? 12 : 4,
				cost: (ctx) => ctx.from?.id === 200 ? 3 : 2,
			})
			.limitFor('user'),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 200 }), next.next);

	assertEquals(next.calls, 2);
	assertEquals(storage.consumeGcraCalls, [
		{
			key: 'middleware:100',
			options: { rate: 2, interval: 1_000, burst: 4, cost: 2 },
		},
		{
			key: 'middleware:200',
			options: { rate: 8, interval: 1_000, burst: 12, cost: 3 },
		},
	]);
});

Deno.test('middleware rejects invalid context-derived GCRA configuration before storage', async () => {
	const storage = new ScriptedStorage();
	const middleware = limit(
		createLimiter()
			.useStorage(storage)
			.gcra({
				rate: 2,
				interval: 1_000,
				burst: 2,
				cost: (ctx) => ctx.from?.id === 100 ? 3 : 1,
			})
			.limitFor('user'),
	);

	await assertRejects(
		async () => {
			await middleware(createTestContext({ userId: 100 }), () => Promise.resolve());
		},
		Error,
		'cost must not exceed burst',
	);
	assertEquals(storage.consumeGcraCalls, []);
});

Deno.test(
	'middleware resolves dynamic Sliding Window limit and request cost per context',
	async () => {
		const storage = new ScriptedStorage();

		storage.slidingWindowResults.push(
			{ isAllowed: true, remaining: 1, reset: 0 },
			{ isAllowed: true, remaining: 2, reset: 0 },
		);

		const next = createNextSpy();
		const middleware = limit(
			createLimiter()
				.useStorage(storage)
				.slidingWindow({
					limit: (ctx) => ctx.from?.id === 200 ? 12 : 4,
					timeFrame: 1_000,
					cost: (ctx) => ctx.from?.id === 200 ? 3 : 2,
				})
				.limitFor('user'),
		);

		await middleware(createTestContext({ userId: 100 }), next.next);
		await middleware(createTestContext({ userId: 200 }), next.next);

		assertEquals(next.calls, 2);
		assertEquals(storage.consumeSlidingWindowCalls, [
			{
				key: 'middleware:100',
				options: { limit: 4, timeFrame: 1_000, cost: 2 },
			},
			{
				key: 'middleware:200',
				options: { limit: 12, timeFrame: 1_000, cost: 3 },
			},
		]);
	},
);

Deno.test(
	'middleware rejects invalid context-derived Sliding Window cost before storage',
	async () => {
		const storage = new ScriptedStorage();
		const middleware = limit(
			createLimiter()
				.useStorage(storage)
				.slidingWindow({
					limit: 2,
					timeFrame: 1_000,
					cost: (ctx) => ctx.from?.id === 100 ? 3 : 1,
				})
				.limitFor('user'),
		);

		await assertRejects(
			async () => {
				await middleware(createTestContext({ userId: 100 }), () => Promise.resolve());
			},
			Error,
			'cost must not exceed limit',
		);
		assertEquals(storage.consumeSlidingWindowCalls, []);
	},
);

Deno.test('named rules annotate decisions and inspections', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 1, reset: 1_000 });

	const decisions: Array<string | undefined> = [];
	const middleware = limit(
		new Limiter()
			.withName('user-messages')
			.withKeyPrefix('named-middleware')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user')
			.on('decision', (_ctx, decision) => decisions.push(decision.ruleName)),
	);

	const ctx = createTestContext();

	await middleware(ctx, () => Promise.resolve());

	const inspection = await middleware.inspect(ctx);

	assertEquals(decisions, ['user-messages']);
	assertEquals(inspection.ruleName, 'user-messages');
});

Deno.test('structured metadata is opt-in and includes built-in plus custom identity', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 1, reset: 1_000 },
	);

	const decisions: unknown[] = [];

	const plain = limit(
		new Limiter()
			.withKeyPrefix('metadata:plain')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user')
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);

	await plain(createTestContext({ userId: 101, chatId: 202 }), () => Promise.resolve());

	type MetadataContext = ReturnType<typeof createTestContext> & { tenantId: string };

	const rich = limit(
		new Limiter<MetadataContext>()
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId, plan: 'pro' as const }))
			.withName('metadata-rich')
			.withKeyPrefix('metadata:rich')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user')
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);
	const richCtx = Object.assign(createTestContext({ userId: 303, chatId: 404 }), {
		tenantId: 'acme',
	}) as MetadataContext;

	await rich(richCtx, () => Promise.resolve());

	assertEquals('metadata' in (decisions[0] as Record<string, unknown>), false);
	assertEquals(decisions[1], {
		outcome: 'allowed',
		ruleName: 'metadata-rich',
		mode: 'enforce',
		entityKey: '303',
		storageKey: 'metadata:rich:303',
		result: { isAllowed: true, remaining: 1, reset: 1_000 },
		metadata: {
			userId: 303,
			chatId: 404,
			custom: { tenantId: 'acme', plan: 'pro' },
		},
	});
});

Deno.test('metadata resolver stays off the middleware hot path without decision listeners', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 1, reset: 1_000 });

	let metadataCalls = 0;
	const middleware = limit(
		new Limiter()
			.withMetadata(() => {
				metadataCalls += 1;

				return { source: 'test' };
			})
			.withKeyPrefix('metadata:lazy')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.limitFor('user'),
	);
	const ctx = createTestContext({ userId: 9, chatId: 10 });

	await middleware(ctx, () => Promise.resolve());
	assertEquals(metadataCalls, 0);

	await middleware.inspect(ctx);
	assertEquals(metadataCalls, 1);
});

Deno.test('metric hooks emit structured middleware and manual-consume decisions lazily', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 1_000 },
	);

	type MetricsContext = ReturnType<typeof createTestContext> & { tenantId: string };

	const metrics: Array<import('../../../src/types.ts').LimiterMetric<{ tenantId: string }>> = [];
	const middleware = limit(
		new Limiter<MetricsContext>()
			.withName('metrics-user')
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId }))
			.withKeyPrefix('metrics:user')
			.useStorage(storage)
			.fixedWindow({ limit: 3, timeFrame: 1_000 })
			.limitFor('user')
			.on('metric', (_ctx, metric) => metrics.push(metric)),
	);
	const ctx = Object.assign(createTestContext({ userId: 14, chatId: 28 }), {
		tenantId: 'acme',
	}) as MetricsContext;

	await middleware(ctx, () => Promise.resolve());
	await middleware.consume(ctx);

	assertEquals(metrics.length, 2);
	assertEquals(metrics[0]?.kind, 'decision');
	assertEquals(metrics[0]?.source, 'middleware');
	assertEquals(metrics[1]?.source, 'manual-consume');

	for (const metric of metrics) {
		if (metric.kind !== 'decision') throw new Error('expected decision metric');

		assertEquals(metric.decision.ruleName, 'metrics-user');
		assertEquals(metric.decision.metadata, {
			userId: 14,
			chatId: 28,
			custom: { tenantId: 'acme' },
		});

		if (metric.durationMs < 0) throw new Error('metric duration must be non-negative');
	}
});
