import { assertEquals } from '@std/assert';
import { ScriptedStorage } from '../../support/scripted_storage.ts';
import { SlidingWindowStrategy } from '../../../src/strategies/sliding_window.ts';

Deno.test(
	'SlidingWindowStrategy forwards normalized options and preserves storage result semantics',
	async () => {
		const storage = new ScriptedStorage();

		storage.slidingWindowResults.push(
			{ isAllowed: true, remaining: 2, reset: 0 },
			{ isAllowed: false, remaining: 0, reset: 250 },
		);

		const strategy = new SlidingWindowStrategy({
			limit: 5,
			timeFrame: 1_000,
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
		assertEquals(storage.consumeSlidingWindowCalls, [
			{
				key: 'user:1',
				options: { limit: 5, timeFrame: 1_000, cost: 1 },
			},
			{
				key: 'user:1',
				options: { limit: 5, timeFrame: 1_000, cost: 1 },
			},
		]);
	},
);

Deno.test('SlidingWindowStrategy supports weighted request cost', async () => {
	const storage = new ScriptedStorage();

	storage.slidingWindowResults.push({ isAllowed: true, remaining: 1, reset: 0 });

	const strategy = new SlidingWindowStrategy({
		limit: 10,
		timeFrame: 2_000,
		cost: 3,
	});

	assertEquals(await strategy.check('user:weighted', storage), {
		isAllowed: true,
		remaining: 1,
		reset: 0,
	});
	assertEquals(storage.consumeSlidingWindowCalls, [
		{
			key: 'user:weighted',
			options: { limit: 10, timeFrame: 2_000, cost: 3 },
		},
	]);
});
