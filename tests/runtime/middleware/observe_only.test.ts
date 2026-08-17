import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { assertEquals, assertRejects } from '@std/assert';
import { createNextSpy } from '../../support/next_spy.ts';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { createTestContext } from '../../support/context.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';
import type { LimiterDecision } from '../../../src/types.ts';

Deno.test('observe-only records allow/throttle decisions without blocking or calling onThrottled', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 900 },
	);

	const next = createNextSpy();
	const decisions: LimiterDecision[] = [];
	let throttledHandlerCalls = 0;

	const middleware = limit(
		new Limiter()
			.withKeyPrefix('observe')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.observeOnly()
			.onThrottled(() => {
				throttledHandlerCalls += 1;
			})
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 100 }), next.next);

	assertEquals(next.calls, 2);
	assertEquals(throttledHandlerCalls, 0);
	assertEquals(storage.incrementCalls, [
		{ key: 'observe:__OBSERVE__:100', ttl: 1_000 },
		{ key: 'observe:__OBSERVE__:100', ttl: 1_000 },
	]);
	assertEquals(decisions.map((decision) => [decision.outcome, decision.mode]), [
		['allowed', 'observe'],
		['throttled', 'observe'],
	]);
});

Deno.test('observe-only shadow state cannot consume enforcement capacity', async () => {
	const storage = new MemoryStore(null);
	const observedNext = createNextSpy();
	const enforcedNext = createNextSpy();

	const observed = limit(
		new Limiter()
			.withKeyPrefix('shared-rule')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user')
			.observeOnly(),
	);
	const enforced = limit(
		new Limiter()
			.withKeyPrefix('shared-rule')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 60_000 })
			.limitFor('user'),
	);

	await observed(createTestContext({ userId: 100 }), observedNext.next);
	await enforced(createTestContext({ userId: 100 }), enforcedNext.next);
	await enforced(createTestContext({ userId: 100 }), enforcedNext.next);

	assertEquals(observedNext.calls, 1);
	assertEquals(enforcedNext.calls, 1);
});

Deno.test('observe-only simulates penalties in the shadow namespace without enforcing them', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 1_000 },
		{ value: 2, reset: 900 },
	);

	const next = createNextSpy();
	const decisions: LimiterDecision[] = [];
	let enforcementPenaltyEvents = 0;

	const middleware = limit(
		new Limiter()
			.withKeyPrefix('observe-penalty')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 10_000 })
			.observeOnly()
			.on('penaltyApplied', () => {
				enforcementPenaltyEvents += 1;
			})
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 100 }), next.next);
	await middleware(createTestContext({ userId: 100 }), next.next);

	assertEquals(next.calls, 3);
	assertEquals(storage.penaltyWrites, [
		{ key: 'observe-penalty:PENALTY:__OBSERVE__:100', ttl: 10_000 },
	]);
	assertEquals(storage.penaltyChecks, [
		'observe-penalty:PENALTY:__OBSERVE__:100',
		'observe-penalty:PENALTY:__OBSERVE__:100',
		'observe-penalty:PENALTY:__OBSERVE__:100',
	]);
	assertEquals(enforcementPenaltyEvents, 0);
	assertEquals(decisions.map((decision) => decision.outcome), [
		'allowed',
		'throttled',
		'penalty-hit',
	]);
});

Deno.test('observe-only reports fail-closed storage decisions but still allows downstream middleware', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('increment', new Error('backend unavailable'));

	const next = createNextSpy();
	const decisions: LimiterDecision[] = [];

	const middleware = limit(
		new Limiter()
			.withKeyPrefix('observe-failure')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.withStorageFailurePolicy('fail-closed')
			.observeOnly()
			.on('decision', (_ctx, decision) => decisions.push(decision)),
	);

	await middleware(createTestContext({ userId: 100 }), next.next);

	assertEquals(next.calls, 1);
	assertEquals(decisions.length, 1);
	assertEquals(decisions[0]?.outcome, 'storage-failure');

	if (decisions[0]?.outcome === 'storage-failure') {
		assertEquals(decisions[0].mode, 'observe');
		assertEquals(decisions[0].resolution, 'fail-closed');
		assertEquals(decisions[0].operation, 'increment');
		assertEquals(decisions[0].key, 'observe-failure:__OBSERVE__:100');
	}
});

Deno.test('observe-only does not swallow storage failures under the default throw policy', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('increment', new Error('backend unavailable'));

	const middleware = limit(
		new Limiter()
			.withKeyPrefix('observe-throw')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.limitFor('user')
			.observeOnly(),
	);

	await assertRejects(
		async () => {
			await middleware(createTestContext({ userId: 100 }), () => Promise.resolve());
		},
		Error,
		'backend unavailable',
	);
});
