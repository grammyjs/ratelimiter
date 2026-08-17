import { assertEquals } from '@std/assert';
import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { createNextSpy } from '../../support/next_spy.ts';
import { limitAll } from '../../../src/core/composite.ts';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { createTestContext } from '../../support/context.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';

function fixedWindowLayer(
	storage: ScriptedStorage,
	prefix: string,
	scope: 'user' | 'chat' | 'global' = 'user',
) {
	return new Limiter()
		.withKeyPrefix(prefix)
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor(scope);
}

Deno.test('limitAll calls downstream only after every layer allows', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 900 },
		{ value: 1, reset: 800 },
		{ value: 1, reset: 700 },
	);

	const next = createNextSpy();

	const middleware = limitAll(
		fixedWindowLayer(storage, 'hierarchy:user', 'user'),
		fixedWindowLayer(storage, 'hierarchy:chat', 'chat'),
		fixedWindowLayer(storage, 'hierarchy:global', 'global'),
	);

	await middleware(createTestContext({ userId: 101, chatId: 202 }), next.next);

	assertEquals(next.calls, 1);
	assertEquals(storage.incrementCalls, [
		{ key: 'hierarchy:user:101', ttl: 1_000 },
		{ key: 'hierarchy:chat:202', ttl: 1_000 },
		{ key: 'hierarchy:global:___GLOBAL___', ttl: 1_000 },
	]);
});

Deno.test('limitAll short-circuits before later layers when an earlier layer throttles', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 2, reset: 750 });

	const next = createNextSpy();

	const middleware = limitAll(
		fixedWindowLayer(storage, 'first'),
		fixedWindowLayer(storage, 'second'),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 0);
	assertEquals(storage.incrementCalls, [{ key: 'first:100', ttl: 1_000 }]);
});

Deno.test('limitAll continues through a bypassed layer', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 1, reset: 900 });

	const next = createNextSpy();

	const bypassed = fixedWindowLayer(storage, 'conditional').onlyIf(() => false);
	const enforced = fixedWindowLayer(storage, 'enforced');
	const middleware = limitAll(bypassed, enforced);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(storage.incrementCalls, [{ key: 'enforced:100', ttl: 1_000 }]);
});

Deno.test('limitAll preserves earlier consumption when a later layer rejects', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 900 },
		{ value: 2, reset: 800 },
	);

	const next = createNextSpy();

	const middleware = limitAll(
		fixedWindowLayer(storage, 'user'),
		fixedWindowLayer(storage, 'global', 'global'),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 0);
	assertEquals(storage.incrementCalls, [
		{ key: 'user:100', ttl: 1_000 },
		{ key: 'global:___GLOBAL___', ttl: 1_000 },
	]);
});

Deno.test('limitAll finalizes builders when the chain is created', async () => {
	const firstStorage = new ScriptedStorage();

	firstStorage.incrementResults.push({ value: 1, reset: 900 });

	const secondStorage = new ScriptedStorage();

	secondStorage.incrementResults.push({ value: 1, reset: 900 });

	const next = createNextSpy();

	const first = fixedWindowLayer(firstStorage, 'original');
	const second = fixedWindowLayer(secondStorage, 'second');
	const middleware = limitAll(first, second);

	first.withKeyPrefix('mutated').fixedWindow({ limit: 99, timeFrame: 99_000 });

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(firstStorage.incrementCalls, [{ key: 'original:100', ttl: 1_000 }]);
	assertEquals(secondStorage.incrementCalls, [{ key: 'second:100', ttl: 1_000 }]);
});

Deno.test('limitAll diagnostics identify the first blocking named layer without consuming capacity', async () => {
	const storage = new MemoryStore(null);
	const first = new Limiter()
		.withName('user')
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 10_000 })
		.limitFor('user')
		.withKeyPrefix('diagnose:chain:user');
	const second = new Limiter()
		.withName('global')
		.useStorage(storage)
		.fixedWindow({ limit: 10, timeFrame: 10_000 })
		.limitFor('global')
		.withKeyPrefix('diagnose:chain:global');
	const middleware = limitAll(first, second);
	const ctx = createTestContext({ userId: 90 });

	await limit(first)(ctx, async () => {});

	const diagnostic = await middleware.diagnose(ctx);

	assertEquals(diagnostic.outcome, 'would-block');

	if (diagnostic.outcome !== 'would-block') {
		throw new Error('expected blocking composite diagnostic');
	}

	assertEquals(diagnostic.blockingLayer, 0);
	assertEquals(diagnostic.layers.length, 1);
	assertEquals(diagnostic.layers[0]?.diagnostic.ruleName, 'user');
	storage.close();
});
