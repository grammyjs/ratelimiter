import { assertEquals } from '@std/assert';
import { GcraStrategy } from '../../../src/strategies/gcra.ts';
import { ScriptedStorage } from '../../support/scripted_storage.ts';

Deno.test('GcraStrategy forwards normalized options and preserves storage result semantics', async () => {
	const storage = new ScriptedStorage();

	storage.gcraResults.push(
		{ isAllowed: true, remaining: 2, reset: 0 },
		{ isAllowed: false, remaining: 0, reset: 250 },
	);

	const strategy = new GcraStrategy({
		rate: 4,
		interval: 1_000,
		burst: 6,
	});

	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: true,
		remaining: 2,
		reset: 0,
	});
	assertEquals(await strategy.check('user:1', storage), {
		isAllowed: false,
		remaining: 0,
		reset: 250,
	});
	assertEquals(strategy.options.cost, 1);
	assertEquals(storage.consumeGcraCalls, [
		{
			key: 'user:1',
			options: { rate: 4, interval: 1_000, burst: 6, cost: 1 },
		},
		{
			key: 'user:1',
			options: { rate: 4, interval: 1_000, burst: 6, cost: 1 },
		},
	]);
});

Deno.test('GcraStrategy supports weighted request cost', async () => {
	const storage = new ScriptedStorage();

	storage.gcraResults.push({ isAllowed: true, remaining: 1, reset: 0 });

	const strategy = new GcraStrategy({
		rate: 5,
		interval: 1_000,
		burst: 10,
		cost: 3,
	});

	assertEquals(await strategy.check('user:weighted', storage), {
		isAllowed: true,
		remaining: 1,
		reset: 0,
	});
	assertEquals(storage.consumeGcraCalls, [
		{
			key: 'user:weighted',
			options: { rate: 5, interval: 1_000, burst: 10, cost: 3 },
		},
	]);
});
