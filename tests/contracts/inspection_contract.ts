import { assert, assertEquals } from '@std/assert';
import type { StorageContractHarnessFactory } from './storage_contract.ts';

/** Registers the optional inspection contract implemented by built-in stores. */
export function defineInspectionStorageContract(
	name: string,
	createHarness: StorageContractHarnessFactory,
): void {
	Deno.test(`${name} inspection contract`, async (t) => {
		await t.step('previews Fixed Window without incrementing state', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const preview = requireMethod(storage.previewFixedWindow, 'previewFixedWindow')
					.bind(storage);
				const options = { limit: 2, timeFrame: 1_000 };

				assertEquals(await preview('fixed-preview', options), {
					isAllowed: true,
					remaining: 1,
					reset: 1_000,
				});
				assertEquals(await preview('fixed-preview', options), {
					isAllowed: true,
					remaining: 1,
					reset: 1_000,
				});
				assertEquals(await storage.increment('fixed-preview', 1_000), {
					value: 1,
					reset: 1_000,
				});
			});
		});

		await t.step('previews Sliding Window without consuming capacity', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const preview = requireMethod(storage.previewSlidingWindow, 'previewSlidingWindow')
					.bind(storage);
				const options = { limit: 2, timeFrame: 1_000, cost: 1 };

				assertEquals(await preview('sliding-preview', options), {
					isAllowed: true,
					remaining: 1,
					reset: 0,
				});
				assertEquals(
					await preview('sliding-preview', options),
					await preview('sliding-preview', options),
				);
				assertEquals(
					(await storage.consumeSlidingWindow('sliding-preview', options)).remaining,
					1,
				);
			});
		});

		await t.step('previews Token Bucket without consuming or persisting refill', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const preview = requireMethod(storage.previewTokenBucket, 'previewTokenBucket')
					.bind(storage);
				const options = {
					bucketSize: 2,
					tokensPerInterval: 1,
					interval: 1_000,
					cost: 1,
					ttl: 2_000,
				};

				assertEquals(await preview('token-preview', options), {
					isAllowed: true,
					tokens: 1,
					reset: 0,
				});
				assertEquals(await storage.consumeTokenBucket('token-preview', options), {
					isAllowed: true,
					tokens: 1,
					reset: 0,
				});
				await advance(500);

				const first = await preview('token-preview', options);
				const second = await preview('token-preview', options);

				assertEquals(first, second);
			});
		});

		await t.step('previews GCRA without advancing its schedule', async () => {
			await usingHarness(createHarness, async ({ storage }) => {
				const preview = requireMethod(storage.previewGcra, 'previewGcra').bind(storage);
				const options = { rate: 1, interval: 1_000, burst: 2, cost: 1 };
				const first = await preview('gcra-preview', options);
				const second = await preview('gcra-preview', options);

				assertEquals(first, second);
				assertEquals(await storage.consumeGcra('gcra-preview', options), first);
			});
		});

		await t.step(
			'reports escalation strike state without extending its reset window',
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

					await apply('penalty-strike-preview', 'strike-preview', {
						basePenaltyTime: 100,
						factor: 2,
						maxPenaltyTime: 400,
						resetAfter: 1_000,
					});
					await advance(250);
					assertEquals(await inspect('strike-preview'), {
						strikes: 1,
						lastPenaltyTime: 100,
						reset: 750,
					});
					await advance(751);
					assertEquals(await inspect('strike-preview'), undefined);
				});
			},
		);

		await t.step('reports remaining penalty lifetime without extending it', async () => {
			await usingHarness(createHarness, async ({ storage, advance }) => {
				const getPenaltyTtl = requireMethod(storage.getPenaltyTtl, 'getPenaltyTtl').bind(
					storage,
				);

				await storage.setPenalty('penalty-preview', 1_000);
				assertEquals(await getPenaltyTtl('penalty-preview'), 1_000);
				await advance(250);
				assertEquals(await getPenaltyTtl('penalty-preview'), 750);
				await advance(751);
				assertEquals(await getPenaltyTtl('penalty-preview'), undefined);
				assertEquals(await storage.checkPenalty('penalty-preview'), false);
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
	run: (harness: Awaited<ReturnType<StorageContractHarnessFactory>>) => Promise<void>,
): Promise<void> {
	const harness = await createHarness();

	try {
		await run(harness);
	} finally {
		await harness.cleanup();
	}
}
