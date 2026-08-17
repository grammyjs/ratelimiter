import { assert, assertEquals } from '@std/assert';

import type {
	GcraConsumeResult,
	IStorageEngine,
	TokenBucketConsumeResult,
} from '../../src/types.ts';

/** Runtime controls supplied by a storage implementation under contract test. */
export interface StorageContractHarness {
	readonly storage: IStorageEngine;
	/** Advances the storage's notion of time by the requested milliseconds. */
	advance(milliseconds: number): void | Promise<void>;
	/** Releases timers/connections and restores any process-wide test state. */
	cleanup(): void | Promise<void>;
}

export type StorageContractHarnessFactory = () =>
	| StorageContractHarness
	| Promise<StorageContractHarness>;

/**
 * Registers the behavioral contract every `IStorageEngine` implementation must satisfy.
 *
 * The suite intentionally asserts externally observable semantics rather than
 * implementation details. New storage engines should be wired to this exact
 * contract, which makes Memory, Redis, and future backends comparable by design.
 */
export function defineStorageContract(
	name: string,
	createHarness: StorageContractHarnessFactory,
): void {
	Deno.test(`${name} storage contract`, async (t) => {
		await t.step('round-trips generic state, expires it, and deletes it', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const value = { count: 3, enabled: false };

				await storage.set('generic', value, 1_000);
				assertEquals(await storage.get<typeof value>('generic'), value);

				await advance(1_001);
				assertEquals(await storage.get<typeof value>('generic'), undefined);

				await storage.set('deleted', value, 1_000);
				await storage.delete('deleted');
				assertEquals(await storage.get<typeof value>('deleted'), undefined);
			});
		});

		await t.step('keeps keys isolated', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				await storage.set('alpha', { value: 1 }, 1_000);
				await storage.set('beta', { value: 2 }, 1_000);

				assertEquals(await storage.get<{ value: number }>('alpha'), { value: 1 });
				assertEquals(await storage.get<{ value: number }>('beta'), { value: 2 });
			});
		});

		await t.step('expires penalty markers without affecting other keys', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				await storage.setPenalty('penalty:a', 500);
				await storage.setPenalty('penalty:b', 2_000);

				assert(await storage.checkPenalty('penalty:a'));
				assert(await storage.checkPenalty('penalty:b'));

				await advance(501);
				assertEquals(await storage.checkPenalty('penalty:a'), false);
				assert(await storage.checkPenalty('penalty:b'));
			});
		});

		await t.step(
			'escalating penalties advance strikes and reset after inactivity',
			async () => {
				await usingHarness(createHarness, async ({ storage, advance }) => {
					const apply = requireMethod(
						storage.applyEscalatingPenalty,
						'applyEscalatingPenalty',
					).bind(storage);
					const inspect = requireMethod(
						storage.getPenaltyStrikeState,
						'getPenaltyStrikeState',
					).bind(storage);
					const options = {
						basePenaltyTime: 100,
						factor: 2,
						maxPenaltyTime: 400,
						resetAfter: 1_000,
					};

					assertEquals(await apply('penalty:escalate', 'strikes:escalate', options), {
						strikes: 1,
						penaltyTime: 100,
						reset: 1_000,
					});
					await advance(101);
					assertEquals(await apply('penalty:escalate', 'strikes:escalate', options), {
						strikes: 2,
						penaltyTime: 200,
						reset: 1_000,
					});
					assertEquals(await inspect('strikes:escalate'), {
						strikes: 2,
						lastPenaltyTime: 200,
						reset: 1_000,
					});

					await advance(1_001);
					assertEquals(await inspect('strikes:escalate'), undefined);
					assertEquals(
						(await apply('penalty:escalate', 'strikes:escalate', options)).strikes,
						1,
					);
				});
			},
		);

		await t.step(
			'escalating penalty strike increments are atomic under concurrency',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const apply = requireMethod(
						storage.applyEscalatingPenalty,
						'applyEscalatingPenalty',
					).bind(storage);
					const results = await Promise.all(
						Array.from(
							{ length: 20 },
							() =>
								apply('penalty:concurrent', 'strikes:concurrent', {
									basePenaltyTime: 10,
									factor: 2,
									maxPenaltyTime: 1_000,
									resetAfter: 5_000,
								}),
						),
					);

					assertEquals(
						results.map((result) => result.strikes).sort((a, b) => a - b),
						Array.from({ length: 20 }, (_, index) => index + 1),
					);
				});
			},
		);

		await t.step(
			'atomic limiter commits every layer only when the whole chain allows',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const consumeAtomic = requireMethod(
						storage.consumeAtomicLimit,
						'consumeAtomicLimit',
					).bind(storage);
					const result = await consumeAtomic([
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:commit:first',
								limit: 2,
								timeFrame: 1_000,
							},
						},
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:commit:second',
								limit: 2,
								timeFrame: 1_000,
							},
						},
					]);

					assertEquals(result.outcome, 'allowed');
					assertEquals((await storage.increment('atomic:commit:first', 1_000)).value, 2);
					assertEquals((await storage.increment('atomic:commit:second', 1_000)).value, 2);
				});
			},
		);

		await t.step(
			'atomic limiter supports every built-in strategy primitive in one transaction',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const consumeAtomic = requireMethod(
						storage.consumeAtomicLimit,
						'consumeAtomicLimit',
					).bind(storage);
					const result = await consumeAtomic([
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:mixed:fixed',
								limit: 3,
								timeFrame: 1_000,
							},
						},
						{
							operation: {
								kind: 'sliding-window',
								key: 'atomic:mixed:sliding',
								options: { limit: 3, timeFrame: 1_000, cost: 1 },
							},
						},
						{
							operation: {
								kind: 'token-bucket',
								key: 'atomic:mixed:token',
								options: {
									bucketSize: 3,
									tokensPerInterval: 1,
									interval: 1_000,
									cost: 1,
									ttl: 3_000,
								},
							},
						},
						{
							operation: {
								kind: 'gcra',
								key: 'atomic:mixed:gcra',
								options: { rate: 3, interval: 1_000, burst: 3, cost: 1 },
							},
						},
					]);

					assertEquals(result.outcome, 'allowed');
					assertEquals(result.results.length, 4);
					assert(result.results.every((entry) => entry.isAllowed));
				});
			},
		);

		await t.step(
			'atomic limiter rolls back earlier capacity when a later layer throttles',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const consumeAtomic = requireMethod(
						storage.consumeAtomicLimit,
						'consumeAtomicLimit',
					).bind(storage);

					await storage.increment('atomic:blocked', 1_000);

					const result = await consumeAtomic([
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:rollback:first',
								limit: 1,
								timeFrame: 1_000,
							},
						},
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:blocked',
								limit: 1,
								timeFrame: 1_000,
							},
						},
					]);

					assertEquals(result.outcome, 'throttled');

					if (result.outcome === 'throttled') {
						assertEquals(result.index, 1);
					}

					assertEquals(
						(await storage.increment('atomic:rollback:first', 1_000)).value,
						1,
					);
				});
			},
		);

		await t.step(
			'atomic limiter rolls back earlier capacity when a later penalty is active',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const consumeAtomic = requireMethod(
						storage.consumeAtomicLimit,
						'consumeAtomicLimit',
					).bind(storage);

					await storage.setPenalty('atomic:penalty:active', 1_000);

					const result = await consumeAtomic([
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:penalty:first',
								limit: 1,
								timeFrame: 1_000,
							},
						},
						{
							operation: {
								kind: 'fixed-window',
								key: 'atomic:penalty:second',
								limit: 1,
								timeFrame: 1_000,
							},
							penaltyKey: 'atomic:penalty:active',
						},
					]);

					assertEquals(result.outcome, 'penalty-hit');

					if (result.outcome === 'penalty-hit') {
						assertEquals(result.index, 1);
					}

					assertEquals((await storage.increment('atomic:penalty:first', 1_000)).value, 1);
				});
			},
		);

		await t.step(
			'atomic limiter keeps multi-layer admission consistent under concurrency',
			async () => {
				await usingHarness(createHarness, async ({ storage }) => {
					const consumeAtomic = requireMethod(
						storage.consumeAtomicLimit,
						'consumeAtomicLimit',
					).bind(storage);
					const layers = [
						{
							operation: {
								kind: 'fixed-window' as const,
								key: 'atomic:concurrent:first',
								limit: 5,
								timeFrame: 5_000,
							},
						},
						{
							operation: {
								kind: 'fixed-window' as const,
								key: 'atomic:concurrent:second',
								limit: 5,
								timeFrame: 5_000,
							},
						},
					];
					const results = await Promise.all(
						Array.from({ length: 20 }, () => consumeAtomic(layers)),
					);

					assertEquals(
						results.filter((result) => result.outcome === 'allowed').length,
						5,
					);
					assertEquals(await storage.get<number>('atomic:concurrent:first'), 5);
					assertEquals(await storage.get<number>('atomic:concurrent:second'), 5);
				});
			},
		);

		await t.step('refund primitives restore one configured request cost', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const refundFixed = requireMethod(storage.refundFixedWindow, 'refundFixedWindow')
					.bind(storage);
				const refundSliding = requireMethod(
					storage.refundSlidingWindow,
					'refundSlidingWindow',
				).bind(storage);
				const refundToken = requireMethod(storage.refundTokenBucket, 'refundTokenBucket')
					.bind(storage);
				const refundGcra = requireMethod(storage.refundGcra, 'refundGcra').bind(storage);

				await storage.increment('refund:fixed', 10_000);
				assertEquals(await refundFixed('refund:fixed', 10_000), true);
				assertEquals((await storage.increment('refund:fixed', 10_000)).value, 1);

				await storage.increment('refund:fixed-rollover', 100);
				await advance(101);
				await storage.increment('refund:fixed-rollover', 100);
				assertEquals(await refundFixed('refund:fixed-rollover', 1), false);
				assertEquals((await storage.increment('refund:fixed-rollover', 100)).value, 2);

				const slidingOptions = { limit: 1, timeFrame: 10_000, cost: 1 };

				assertEquals(
					(await storage.consumeSlidingWindow('refund:sliding', slidingOptions))
						.isAllowed,
					true,
				);
				await refundSliding('refund:sliding', slidingOptions);
				assertEquals(
					(await storage.consumeSlidingWindow('refund:sliding', slidingOptions))
						.isAllowed,
					true,
				);

				const tokenOptions = {
					bucketSize: 1,
					tokensPerInterval: 1,
					interval: 10_000,
					cost: 1,
					ttl: 10_000,
				};

				assertEquals(
					(await storage.consumeTokenBucket('refund:token', tokenOptions)).isAllowed,
					true,
				);
				await refundToken('refund:token', tokenOptions);
				assertEquals(
					(await storage.consumeTokenBucket('refund:token', tokenOptions)).isAllowed,
					true,
				);

				const gcraOptions = { rate: 1, interval: 10_000, burst: 1, cost: 1 };

				assertEquals(
					(await storage.consumeGcra('refund:gcra', gcraOptions)).isAllowed,
					true,
				);
				await refundGcra('refund:gcra', gcraOptions);
				assertEquals(
					(await storage.consumeGcra('refund:gcra', gcraOptions)).isAllowed,
					true,
				);
			});
		});

		await t.step('fixed-window increments preserve the first expiry', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				assertEquals(await storage.increment('fixed', 1_000), { value: 1, reset: 1_000 });

				await advance(250);
				assertEquals(await storage.increment('fixed', 1_000), { value: 2, reset: 750 });

				await advance(751);
				assertEquals(await storage.increment('fixed', 1_000), { value: 1, reset: 1_000 });
			});
		});

		await t.step('fixed-window increments are atomic under concurrency', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const results = await Promise.all(
					Array.from({ length: 50 }, () => storage.increment('fixed-concurrent', 5_000)),
				);
				const values = results.map((result) => result.value).sort((a, b) => a - b);

				assertEquals(values, Array.from({ length: 50 }, (_, index) => index + 1));
				assert(results.every((result) => result.reset === 5_000));
			});
		});

		await t.step('token bucket enforces burst capacity and fractional refill', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const consume = () =>
					storage.consumeTokenBucket('bucket', {
						bucketSize: 3,
						tokensPerInterval: 1,
						interval: 1_000,
						cost: 1,
						ttl: 3_000,
					});

				assertTokenResult(await consume(), true, 2, 0);
				assertTokenResult(await consume(), true, 1, 0);
				assertTokenResult(await consume(), true, 0, 1_000);
				assertTokenResult(await consume(), false, 0, 1_000);

				await advance(500);
				assertTokenResult(await consume(), false, 0.5, 500);

				await advance(500);
				assertTokenResult(await consume(), true, 0, 1_000);
			});
		});

		await t.step('token bucket supports weighted consumption and refill', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const consume = () =>
					storage.consumeTokenBucket('bucket-weighted', {
						bucketSize: 10,
						tokensPerInterval: 1,
						interval: 1_000,
						cost: 3,
						ttl: 10_000,
					});

				assertTokenResult(await consume(), true, 7, 0);
				assertTokenResult(await consume(), true, 4, 0);
				assertTokenResult(await consume(), true, 1, 2_000);
				assertTokenResult(await consume(), false, 1, 2_000);

				await advance(2_000);
				assertTokenResult(await consume(), true, 0, 3_000);
			});
		});

		await t.step('weighted token bucket consumption is atomic under concurrency', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const results = await Promise.all(
					Array.from(
						{ length: 20 },
						() =>
							storage.consumeTokenBucket('bucket-weighted-concurrent', {
								bucketSize: 10,
								tokensPerInterval: 1,
								interval: 1_000,
								cost: 3,
								ttl: 10_000,
							}),
					),
				);

				assertEquals(results.filter((result) => result.isAllowed).length, 3);
				assert(results.every((result) => result.tokens >= 0 && result.tokens <= 10));
				assert(results.every((result) => result.reset >= 0));
			});
		});

		await t.step('token bucket consumption is atomic under concurrency', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const results = await Promise.all(
					Array.from(
						{ length: 100 },
						() =>
							storage.consumeTokenBucket('bucket-concurrent', {
								bucketSize: 7,
								tokensPerInterval: 2,
								interval: 1_000,
								cost: 1,
								ttl: 4_000,
							}),
					),
				);

				assertEquals(results.filter((result) => result.isAllowed).length, 7);
				assert(results.every((result) => result.tokens >= 0 && result.tokens <= 7));
				assert(results.every((result) => result.reset >= 0));
			});
		});

		await t.step('sliding window smooths capacity across fixed boundaries', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const consume = () =>
					storage.consumeSlidingWindow('sliding', {
						limit: 4,
						timeFrame: 1_000,
						cost: 1,
					});

				assertSlidingResult(await consume(), true, 3, 0);
				assertSlidingResult(await consume(), true, 2, 0);
				assertSlidingResult(await consume(), true, 1, 0);
				assertSlidingResult(await consume(), true, 0, 1_250);
				assertSlidingResult(await consume(), false, 0, 1_250);

				await advance(1_000);
				assertSlidingResult(await consume(), false, 0, 250);

				await advance(250);
				assertSlidingResult(await consume(), true, 0, 250);
			});
		});

		await t.step('sliding window supports weighted consumption', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const consume = () =>
					storage.consumeSlidingWindow('sliding-weighted', {
						limit: 10,
						timeFrame: 1_000,
						cost: 3,
					});

				assertSlidingResult(await consume(), true, 2, 0);
				assertSlidingResult(await consume(), true, 1, 0);
				assertSlidingResult(await consume(), true, 0, 1_223);
				assertSlidingResult(await consume(), false, 0, 1_223);

				await advance(1_000);
				assertSlidingResult(await consume(), false, 0, 223);

				await advance(223);

				const recovered = await consume();

				assertEquals(recovered.isAllowed, true);
				assertEquals(recovered.remaining, 0);
				assert(recovered.reset >= 332 && recovered.reset <= 334);
			});
		});

		await t.step('sliding-window consumption is atomic under concurrency', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const results = await Promise.all(
					Array.from(
						{ length: 50 },
						() =>
							storage.consumeSlidingWindow('sliding-concurrent', {
								limit: 7,
								timeFrame: 1_000,
								cost: 1,
							}),
					),
				);

				assertEquals(results.filter((result) => result.isAllowed).length, 7);
				assert(results.every((result) => result.remaining >= 0));
				assert(results.every((result) => result.reset >= 0));
			});
		});

		await t.step(
			'GCRA allows the configured burst and then spaces requests smoothly',
			async () => {
				await usingHarness(createHarness, async ({ storage, advance }) => {
					const consume = () =>
						storage.consumeGcra('gcra', {
							rate: 1,
							interval: 1_000,
							burst: 3,
							cost: 1,
						});

					assertGcraResult(await consume(), true, 2, 0);
					assertGcraResult(await consume(), true, 1, 0);
					assertGcraResult(await consume(), true, 0, 1_000);
					assertGcraResult(await consume(), false, 0, 1_000);

					await advance(400);
					assertGcraResult(await consume(), false, 0, 600);

					await advance(600);
					assertGcraResult(await consume(), true, 0, 1_000);
				});
			},
		);

		await t.step('GCRA supports weighted requests', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const consume = () =>
					storage.consumeGcra('gcra-weighted', {
						rate: 2,
						interval: 1_000,
						burst: 6,
						cost: 2,
					});

				assertGcraResult(await consume(), true, 2, 0);
				assertGcraResult(await consume(), true, 1, 0);
				assertGcraResult(await consume(), true, 0, 1_000);
				assertGcraResult(await consume(), false, 0, 1_000);
			});
		});

		await t.step('GCRA consumption is atomic under concurrency', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const results = await Promise.all(
					Array.from({ length: 50 }, () =>
						storage.consumeGcra('gcra-concurrent', {
							rate: 5,
							interval: 1_000,
							burst: 7,
							cost: 1,
						})),
				);

				assertEquals(results.filter((result) => result.isAllowed).length, 7);
				assert(results.every((result) => result.remaining >= 0));
				assert(results.every((result) => result.reset >= 0));
			});
		});
	});
}

function requireMethod<T extends (...args: never[]) => unknown>(
	method: T | undefined,
	name: string,
): T {
	assert(method !== undefined, `${name} must be implemented by built-in stores`);

	return method;
}

async function usingHarness(
	createHarness: StorageContractHarnessFactory,
	run: (harness: StorageContractHarness) => void | Promise<void>,
): Promise<void> {
	const harness = await createHarness();

	try {
		await run(harness);
	} finally {
		await harness.cleanup();
	}
}

function assertTokenResult(
	actual: TokenBucketConsumeResult,
	isAllowed: boolean,
	tokens: number,
	reset: number,
): void {
	assertEquals(actual.isAllowed, isAllowed);
	assertEquals(actual.tokens, tokens);
	assertEquals(actual.reset, reset);
}

function assertSlidingResult(
	actual: { isAllowed: boolean; remaining: number; reset: number },
	isAllowed: boolean,
	remaining: number,
	reset: number,
): void {
	assertEquals(actual, { isAllowed, remaining, reset });
}

function assertGcraResult(
	actual: GcraConsumeResult,
	isAllowed: boolean,
	remaining: number,
	reset: number,
): void {
	assertEquals(actual, { isAllowed, remaining, reset });
}
