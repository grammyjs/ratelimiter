import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@grammyjs/ratelimiter/storages';

import {
	defineLimiterPreset,
	limit,
	limitAll,
	limitAllAtomic,
	Limiter,
} from '@grammyjs/ratelimiter';

const createMockContext = (id) => ({
	from: { id },
	chat: { id },
});

test('built package runs under Node.js through package exports', async () => {
	// Keep cleanup enabled so this smoke test also exercises deno2node's
	// platform swap and the Node.js timer `unref()` path.
	const storage = new MemoryStore(60_000);
	const limiter = new Limiter()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.withKeyPrefix('node-smoke');

	const middleware = limit(limiter);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;

		return Promise.resolve();
	};

	await middleware(createMockContext(100), next);
	await middleware(createMockContext(100), next);

	assert.equal(nextCalls, 1);
	storage.close();
});

test('built MemoryStore smooths Sliding Window capacity across a boundary', async () => {
	const originalNow = Date.now;
	let now = 1_000_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const middleware = limit(
			new Limiter()
				.useStorage(storage)
				.slidingWindow({ limit: 4, timeFrame: 1_000 })
				.limitFor('user')
				.withKeyPrefix('node-sliding-window'),
		);
		let nextCalls = 0;
		const next = () => {
			nextCalls += 1;

			return Promise.resolve();
		};
		const ctx = createMockContext(100);

		for (let index = 0; index < 4; index += 1) {
			await middleware(ctx, next);
		}

		await middleware(ctx, next);
		assert.equal(nextCalls, 4);

		now += 1_000;
		await middleware(ctx, next);
		assert.equal(nextCalls, 4, 'the fixed boundary must not restore full capacity');

		now += 250;
		await middleware(ctx, next);
		assert.equal(nextCalls, 5);
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

test('built MemoryStore keeps Token Bucket consumption atomic in Node.js', async () => {
	const storage = new MemoryStore(60_000);
	const limiter = new Limiter()
		.useStorage(storage)
		.tokenBucket({ bucketSize: 3, tokensPerInterval: 1, interval: 1_000 })
		.limitFor('user')
		.withKeyPrefix('node-token-bucket');

	const middleware = limit(limiter);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;

		return Promise.resolve();
	};

	await Promise.all(
		Array.from({ length: 20 }, () => middleware(createMockContext(100), next)),
	);

	assert.equal(nextCalls, 3);
	storage.close();
});

test('built MemoryStore keeps GCRA burst admission atomic in Node.js', async () => {
	const storage = new MemoryStore(60_000);
	const limiter = new Limiter()
		.useStorage(storage)
		.gcra({ rate: 3, interval: 1_000, burst: 5 })
		.limitFor('user')
		.withKeyPrefix('node-gcra');

	const middleware = limit(limiter);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;

		return Promise.resolve();
	};

	await Promise.all(
		Array.from({ length: 20 }, () => middleware(createMockContext(100), next)),
	);

	assert.equal(nextCalls, 5);
	storage.close();
});

test('built package composes hierarchical limits through limitAll', async () => {
	const storage = new MemoryStore(null);
	const middleware = limitAll(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-hierarchy:user'),
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('global')
			.withKeyPrefix('node-hierarchy:global'),
	);

	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;

		return Promise.resolve();
	};

	await middleware(createMockContext(100), next);
	await middleware(createMockContext(200), next);

	assert.equal(nextCalls, 1);
});

test('built package preserves observe-only behavior through deno2node', async () => {
	const storage = new MemoryStore(null);
	const limiter = new Limiter()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.limitFor('user')
		.withKeyPrefix('node-observe')
		.observeOnly();

	const middleware = limit(limiter);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;

		return Promise.resolve();
	};

	await middleware(createMockContext(100), next);
	await middleware(createMockContext(100), next);

	assert.equal(nextCalls, 2);
});

test('default penalty namespaces do not leak across rules sharing a store', async () => {
	const storage = new MemoryStore(null);
	const first = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-penalty:first')
			.withPenalty({ penaltyTime: 10_000 }),
	);
	const second = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-penalty:second')
			.withPenalty({ penaltyTime: 10_000 }),
	);

	let firstNextCalls = 0;
	let secondNextCalls = 0;
	const ctx = createMockContext(100);

	await first(ctx, () => {
		firstNextCalls += 1;

		return Promise.resolve();
	});
	await first(ctx, () => {
		firstNextCalls += 1;

		return Promise.resolve();
	});
	await second(ctx, () => {
		secondNextCalls += 1;

		return Promise.resolve();
	});

	assert.equal(firstNextCalls, 1);
	assert.equal(secondNextCalls, 1);
});

test('built limiter middleware exposes non-consuming state controls', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-controls')
			.withPenalty({ penaltyTime: 5_000 }),
	);
	const ctx = createMockContext(321);
	const next = () => Promise.resolve();

	await controlled(ctx, next);

	const first = await controlled.inspect(ctx);
	const second = await controlled.inspect(ctx);

	assert.equal(first.outcome, 'ready');
	assert.equal(second.outcome, 'ready');
	assert.equal(first.strategy.supported, true);
	assert.equal(second.strategy.supported, true);
	assert.equal(first.strategy.result.isAllowed, true);
	assert.equal(second.strategy.result.isAllowed, true);
	assert.equal(
		first.strategy.result.remaining,
		second.strategy.result.remaining,
		'inspection must not consume limiter capacity',
	);
	assert.ok(
		second.strategy.result.reset <= first.strategy.result.reset,
		'inspection may observe elapsed wall-clock time but must not extend the reset window',
	);

	await controlled(ctx, next);
	await controlled(ctx, next);

	const throttled = await controlled.inspect(ctx);

	assert.equal(throttled.outcome, 'ready');
	assert.equal(throttled.penalty.configured, true);
	assert.equal(throttled.penalty.active, true);

	assert.equal(await controlled.reset(ctx), true);

	const afterReset = await controlled.inspect(ctx);

	assert.equal(afterReset.outcome, 'ready');
	assert.equal(afterReset.strategy.result.isAllowed, true);
	assert.equal(afterReset.penalty.active, true);

	assert.equal(await controlled.clearPenalty(ctx), true);

	const afterClear = await controlled.inspect(ctx);

	assert.equal(afterClear.outcome, 'ready');
	assert.equal(afterClear.penalty.active, false);
});

test('built limiter escalates penalties and exposes strike controls', async () => {
	const originalNow = Date.now;
	let now = 1_000_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const controlled = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 1, timeFrame: 10_000 })
				.limitFor('user')
				.withKeyPrefix('node-escalation')
				.withPenalty({
					penaltyTime: 100,
					escalation: { factor: 2, maxPenaltyTime: 400, resetAfter: 2_000 },
				}),
		);
		const ctx = createMockContext(404);
		const next = () => Promise.resolve();

		await controlled(ctx, next);
		await controlled(ctx, next);

		let state = await controlled.inspect(ctx);

		assert.equal(state.penalty.escalation.strikes, 1);
		assert.equal(state.penalty.expiresIn, 100);

		now += 101;
		await controlled(ctx, next);
		state = await controlled.inspect(ctx);
		assert.equal(state.penalty.escalation.strikes, 2);
		assert.equal(state.penalty.expiresIn, 200);

		assert.equal(await controlled.clearStrikes(ctx), true);
		state = await controlled.inspect(ctx);
		assert.equal(state.penalty.escalation.strikes, 0);
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

test('built package preserves all-or-nothing capacity through limitAllAtomic', async () => {
	const storage = new MemoryStore(null);

	await storage.increment('node-atomic:global:___GLOBAL___', 10_000);

	const middleware = limitAllAtomic(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-atomic:user'),
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('global')
			.withKeyPrefix('node-atomic:global'),
	);

	let nextCalls = 0;

	await middleware(createMockContext(500), () => {
		nextCalls += 1;

		return Promise.resolve();
	});

	assert.equal(nextCalls, 0);
	assert.equal(await storage.get('node-atomic:user:500'), undefined);
	assert.equal(await storage.get('node-atomic:global:___GLOBAL___'), 1);
	storage.close();
});

test('built package preserves named rule identity in decisions and inspection', async () => {
	const storage = new MemoryStore(null);
	const names = [];
	const middleware = limit(
		new Limiter()
			.withName('node-user-messages')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-named-rule')
			.on('decision', (_ctx, decision) => names.push(decision.ruleName)),
	);
	const ctx = createMockContext(654);

	await middleware(ctx, () => Promise.resolve());

	const inspection = await middleware.inspect(ctx);

	assert.deepEqual(names, ['node-user-messages']);
	assert.equal(inspection.ruleName, 'node-user-messages');
});

test('built package exposes opt-in rich identity metadata', async () => {
	const storage = new MemoryStore(null);
	const decisions = [];
	const middleware = limit(
		new Limiter()
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId, plan: 'pro' }))
			.withName('node-rich-metadata')
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-rich-metadata')
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);
	const ctx = Object.assign(createMockContext(777), { tenantId: 'acme' });

	await middleware(ctx, () => Promise.resolve());

	const inspection = await middleware.inspect(ctx);

	assert.deepEqual(decisions[0].metadata, {
		userId: 777,
		chatId: 777,
		custom: { tenantId: 'acme', plan: 'pro' },
	});
	assert.deepEqual(inspection.metadata, decisions[0].metadata);
	storage.close();
});

test('built limiter supports manual consumption without grammY next()', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.withName('node-manual-consume')
			.withMetadata((ctx) => ({ tenantId: ctx.tenantId }))
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-manual-consume'),
	);
	const ctx = Object.assign(createMockContext(808), { tenantId: 'acme' });

	const first = await controlled.consume(ctx);
	const second = await controlled.consume(ctx);

	assert.equal(first.isAllowed, true);
	assert.equal(first.outcome, 'allowed');
	assert.equal(first.ruleName, 'node-manual-consume');
	assert.deepEqual(first.metadata, {
		userId: 808,
		chatId: 808,
		custom: { tenantId: 'acme' },
	});
	assert.equal(second.isAllowed, false);
	assert.equal(second.outcome, 'throttled');
	storage.close();
});

test('built Fixed Window refund cannot credit a newer window after rollover', async () => {
	const originalNow = Date.now;
	let now = 10_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const limiter = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 2, timeFrame: 1_000 })
				.limitFor('user')
				.withKeyPrefix('node-refund-rollover'),
		);
		const ctx = createMockContext(811);
		const oldWindow = await limiter.consume(ctx);

		now += 1_001;

		assert.equal((await limiter.consume(ctx)).outcome, 'allowed');
		assert.equal(await limiter.refund(oldWindow), false);
		assert.equal((await limiter.consume(ctx)).outcome, 'allowed');
		assert.equal((await limiter.consume(ctx)).outcome, 'throttled');
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

test('built limiter refunds one successful manual consumption exactly once', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-manual-refund'),
	);
	const ctx = createMockContext(909);
	const consumed = await controlled.consume(ctx);

	assert.equal(consumed.outcome, 'allowed');
	assert.equal(await controlled.refund(consumed), true);
	assert.equal(await controlled.refund(consumed), false);
	assert.equal((await controlled.consume(ctx)).outcome, 'allowed');
	storage.close();
});

test('built package exposes cooldown as a true minimum action interval', async () => {
	const originalNow = Date.now;
	let now = 3_000_000;

	Date.now = () => now;

	const storage = new MemoryStore(null);

	try {
		const controlled = limit(
			new Limiter()
				.useStorage(storage)
				.cooldown(1_000)
				.limitFor('user')
				.withKeyPrefix('node-cooldown'),
		);
		const ctx = createMockContext(1001);

		assert.equal((await controlled.consume(ctx)).outcome, 'allowed');
		assert.equal((await controlled.consume(ctx)).outcome, 'throttled');
		now += 999;
		assert.equal((await controlled.consume(ctx)).outcome, 'throttled');
		now += 1;
		assert.equal((await controlled.consume(ctx)).outcome, 'allowed');
	} finally {
		Date.now = originalNow;
		storage.close();
	}
});

test('built package exposes scope preset factories without hidden policy', () => {
	const storage = new MemoryStore(null);
	const user = Limiter.perUser()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.withKeyPrefix('node-preset-user')
		.build();
	const chat = Limiter.perChat()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.withKeyPrefix('node-preset-chat')
		.build();
	const pair = Limiter.perUserPerChat()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.withKeyPrefix('node-preset-pair')
		.build();
	const global = Limiter.global()
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.withKeyPrefix('node-preset-global')
		.build();

	const ctx = createMockContext(17);

	ctx.chat.id = -99;
	assert.equal(user.keyGenerator(ctx), '17');
	assert.equal(chat.keyGenerator(ctx), '-99');
	assert.equal(pair.keyGenerator(ctx), '17:-99');
	assert.equal(global.keyGenerator(ctx), global.keyGenerator(createMockContext(999)));
	storage.close();
});

test('built package creates fresh reusable limiter presets', () => {
	const storage = new MemoryStore(null);
	let calls = 0;
	const preset = defineLimiterPreset(() => {
		calls += 1;

		return Limiter.perUser()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.withKeyPrefix('node-reusable-preset');
	});
	const first = preset.apply().withName('first').build();
	const second = preset.apply().withName('second').build();

	assert.equal(calls, 2);
	assert.equal(first.name, 'first');
	assert.equal(second.name, 'second');
	storage.close();
});

test('built package exposes explicit non-consuming diagnostics', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.withName('node-diagnostic')
			.withMetadata()
			.useStorage(storage)
			.cooldown(10_000)
			.limitFor('user')
			.withKeyPrefix('node-diagnostic'),
	);
	const ctx = createMockContext(1200);

	const before = await controlled.diagnose(ctx);

	assert.equal(before.outcome, 'would-allow');
	assert.equal(before.strategy.kind, 'cooldown');
	assert.deepEqual(before.metadata, { userId: 1200, chatId: 1200 });
	assert.equal((await controlled.consume(ctx)).outcome, 'allowed');

	const after = await controlled.diagnose(ctx);

	assert.equal(after.outcome, 'would-throttle');
	assert.equal(after.wouldContinue, false);
	storage.close();
});

test('built composite diagnostics identify the blocking named layer', async () => {
	const storage = new MemoryStore(null);
	const user = new Limiter()
		.withName('user')
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.limitFor('user')
		.withKeyPrefix('node-diagnostic:user');
	const global = new Limiter()
		.withName('global')
		.useStorage(storage)
		.fixedWindow({ limit: 10, timeFrame: 10_000 })
		.limitFor('global')
		.withKeyPrefix('node-diagnostic:global');
	const userOnly = limit(user);
	const ctx = createMockContext(1201);

	await userOnly.consume(ctx);

	const diagnostic = await limitAll(user, global).diagnose(ctx);

	assert.equal(diagnostic.outcome, 'would-block');
	assert.equal(diagnostic.blockingLayer, 0);
	assert.equal(diagnostic.layers[0].diagnostic.ruleName, 'user');
	storage.close();
});

test('built package emits vendor-neutral decision and refund metrics', async () => {
	const storage = new MemoryStore(null);
	const metrics = [];
	const controlled = limit(
		new Limiter()
			.withName('node-metrics')
			.withMetadata()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('node-metrics')
			.on('metric', (_ctx, metric) => metrics.push(metric)),
	);
	const ctx = createMockContext(1300);

	let nextCalls = 0;

	await controlled(ctx, () => {
		nextCalls += 1;
	});

	const consumed = await controlled.consume(ctx);

	assert.equal(await controlled.refund(consumed), true);

	assert.equal(nextCalls, 1);
	assert.deepEqual(metrics.map((metric) => `${metric.kind}:${metric.source}`), [
		'decision:middleware',
		'decision:manual-consume',
		'refund:refund',
	]);

	for (const metric of metrics) {
		assert.equal(metric.durationMs >= 0, true);
	}

	const first = metrics[0];

	assert.equal(first.decision.ruleName, 'node-metrics');
	assert.deepEqual(first.decision.metadata, { userId: 1300, chatId: 1300 });
	storage.close();
});
