import { assertEquals } from '@std/assert';
import { ScriptedStorage } from '../../support/scripted_storage.ts';
import { FixedWindowStrategy } from '../../../src/strategies/fixed_window.ts';

Deno.test('FixedWindowStrategy maps atomic counter state to LimitResult', async () => {
	const storage = new ScriptedStorage();

	storage.incrementResults.push(
		{ value: 1, reset: 900 },
		{ value: 3, reset: 500 },
		{ value: 4, reset: 250 },
	);

	const strategy = new FixedWindowStrategy({ limit: 3, timeFrame: 1_000 });

	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: true,
		remaining: 2,
		reset: 900,
	});
	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: true,
		remaining: 0,
		reset: 500,
	});
	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: false,
		remaining: 0,
		reset: 250,
	});

	assertEquals(storage.incrementCalls, [
		{ key: 'user:1', ttl: 1_000 },
		{ key: 'user:1', ttl: 1_000 },
		{ key: 'user:1', ttl: 1_000 },
	]);
});
