import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { assertEquals, assertRejects } from '@std/assert';
import { createNextSpy } from '../../support/next_spy.ts';
import { createTestContext } from '../../support/context.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';

const createFixedWindowLimiter = (storage: ScriptedStorage) =>
	new Limiter()
		.withKeyPrefix('failure')
		.useStorage(storage)
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user');

Deno.test('storage failures throw by default and expose original error metadata', async () => {
	const storage = new ScriptedStorage();
	const failure = new Error('redis unavailable');

	storage.failures.set('increment', failure);

	const seen: Array<{ phase: string; operation: string; error: unknown }> = [];
	const middleware = limit(
		createFixedWindowLimiter(storage).on('storageError', (_ctx, info) => {
			seen.push({ phase: info.phase, operation: info.operation, error: info.error });
		}),
	);

	await assertRejects(
		async () => await middleware(createTestContext(), () => Promise.resolve()),
		Error,
		'redis unavailable',
	);

	assertEquals(seen, [{ phase: 'strategy-check', operation: 'increment', error: failure }]);
});

Deno.test('fail-open ignores a failed penalty lookup and still evaluates the strategy', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('checkPenalty', new Error('penalty lookup failed'));
	storage.incrementResults.push({ value: 1, reset: 1_000 });

	const next = createNextSpy();
	const phases: string[] = [];
	const middleware = limit(
		createFixedWindowLimiter(storage)
			.withPenalty({ penaltyTime: 1_000 })
			.withStorageFailurePolicy('fail-open')
			.on('storageError', (_ctx, info) => phases.push(info.phase)),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(storage.incrementCalls.length, 1);
	assertEquals(phases, ['penalty-check']);
});

Deno.test('fail-closed stops when a penalty lookup cannot be trusted', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('checkPenalty', new Error('penalty lookup failed'));

	const next = createNextSpy();
	const middleware = limit(
		createFixedWindowLimiter(storage)
			.withPenalty({ penaltyTime: 1_000 })
			.withStorageFailurePolicy('fail-closed'),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 0);
	assertEquals(storage.incrementCalls, []);
});

Deno.test('fail-open bypasses a failed strategy check instead of emitting allowed', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('increment', new Error('counter failed'));

	const next = createNextSpy();
	const events: string[] = [];
	const middleware = limit(
		createFixedWindowLimiter(storage)
			.withStorageFailurePolicy('fail-open')
			.on('allowed', () => events.push('allowed'))
			.on('bypassed', (_ctx, info) => events.push(`${info.reason}:${info.phase}`)),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(events, ['storage-failure:strategy-check']);
});

Deno.test('fail-closed rejects traffic when strategy state cannot be evaluated', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('increment', new Error('counter failed'));

	const next = createNextSpy();
	const middleware = limit(
		createFixedWindowLimiter(storage).withStorageFailurePolicy('fail-closed'),
	);

	await middleware(createTestContext(), next.next);
	assertEquals(next.calls, 0);
});

Deno.test('async storage failure resolver can choose behavior per phase and operation', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('checkPenalty', new Error('penalty failed'));
	storage.incrementResults.push({ value: 1, reset: 1_000 });

	const next = createNextSpy();
	const decisions: string[] = [];
	const middleware = limit(
		createFixedWindowLimiter(storage)
			.withPenalty({ penaltyTime: 1_000 })
			.withStorageFailurePolicy(async (_ctx, info) => {
				await Promise.resolve();
				decisions.push(`${info.phase}:${info.operation}`);

				return info.phase === 'penalty-check' ? 'fail-open' : 'throw';
			}),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(decisions, ['penalty-check:checkPenalty']);
});

Deno.test('non-throw policy suppresses penalty persistence failure after throttling', async () => {
	for (const policy of ['fail-open', 'fail-closed'] as const) {
		const storage = new ScriptedStorage();

		storage.incrementResults.push({ value: 2, reset: 500 });
		storage.failures.set('setPenalty', new Error('penalty write failed'));

		const events: string[] = [];
		const middleware = limit(
			createFixedWindowLimiter(storage)
				.withPenalty({ penaltyTime: 1_000 })
				.withStorageFailurePolicy(policy)
				.on('throttled', () => events.push('throttled'))
				.on('penaltyApplied', () => events.push('penaltyApplied'))
				.on('storageError', (_ctx, info) => events.push(info.phase)),
		);

		await middleware(createTestContext(), () => Promise.resolve());
		assertEquals(events, ['throttled', 'penalty-write']);
	}
});

Deno.test('escalating penalty writes use the penalty-write failure policy', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push({ value: 2, reset: 500 });

	const failure = new Error('escalating penalty write failed');

	storage.failures.set('applyEscalatingPenalty', failure);

	const seen: Array<{ phase: string; operation: string; error: unknown }> = [];
	const middleware = limit(
		createFixedWindowLimiter(storage)
			.withPenalty({
				penaltyTime: 1_000,
				escalation: { maxPenaltyTime: 8_000, resetAfter: 60_000 },
			})
			.withStorageFailurePolicy('fail-open')
			.on('storageError', (_ctx, info) => {
				seen.push({ phase: info.phase, operation: info.operation, error: info.error });
			}),
	);

	await middleware(createTestContext(), () => Promise.resolve());
	assertEquals(seen, [{
		phase: 'penalty-write',
		operation: 'applyEscalatingPenalty',
		error: failure,
	}]);
});

Deno.test('fail-open never hides an exception thrown by strategy code itself', async () => {
	const storage = new ScriptedStorage();
	const middleware = limit(
		new Limiter()
			.withKeyPrefix('custom')
			.useStorage(storage)
			.customStrategy({
				check: () => Promise.reject(new Error('strategy bug')),
			})
			.limitFor('user')
			.withStorageFailurePolicy('fail-open'),
	);

	await assertRejects(
		async () => await middleware(createTestContext(), () => Promise.resolve()),
		Error,
		'strategy bug',
	);
});

Deno.test('invalid custom storage failure decision is rejected explicitly', async () => {
	const storage = new ScriptedStorage();

	storage.failures.set('increment', new Error('counter failed'));

	const middleware = limit(
		createFixedWindowLimiter(storage).withStorageFailurePolicy(
			// Deliberately exercise runtime validation for untyped JavaScript consumers.
			(() => 'maybe') as never,
		),
	);

	await assertRejects(
		async () => await middleware(createTestContext(), () => Promise.resolve()),
		Error,
		'storage failure policy resolver must return',
	);
});

Deno.test('storage failure policy classifies GCRA backend failures without hiding them', async () => {
	const storage = new ScriptedStorage();
	const failure = new Error('GCRA backend failed');

	storage.failures.set('consumeGcra', failure);

	const next = createNextSpy();
	const seen: Array<{ operation: string; error: unknown }> = [];
	const middleware = limit(
		new Limiter()
			.withKeyPrefix('gcra-failure')
			.useStorage(storage)
			.gcra({ rate: 2, interval: 1_000, burst: 3 })
			.limitFor('user')
			.withStorageFailurePolicy('fail-open')
			.on('storageError', (_ctx, info) => {
				seen.push({ operation: info.operation, error: info.error });
			}),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(seen, [{ operation: 'consumeGcra', error: failure }]);
});

Deno.test('storage failure policy classifies Sliding Window backend failures', async () => {
	const storage = new ScriptedStorage();
	const failure = new Error('Sliding Window backend failed');

	storage.failures.set('consumeSlidingWindow', failure);

	const next = createNextSpy();
	const seen: Array<{ operation: string; error: unknown }> = [];
	const middleware = limit(
		new Limiter()
			.withKeyPrefix('sliding-failure')
			.useStorage(storage)
			.slidingWindow({ limit: 5, timeFrame: 1_000 })
			.limitFor('user')
			.withStorageFailurePolicy('fail-open')
			.on('storageError', (_ctx, info) => {
				seen.push({ operation: info.operation, error: info.error });
			}),
	);

	await middleware(createTestContext(), next.next);

	assertEquals(next.calls, 1);
	assertEquals(seen, [{ operation: 'consumeSlidingWindow', error: failure }]);
});
