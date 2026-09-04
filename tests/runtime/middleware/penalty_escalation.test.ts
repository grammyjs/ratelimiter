import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { withFakeClock } from '../../support/fake_clock.ts';
import { createTestContext } from '../../support/context.ts';
import type { LimiterInspection } from '../../../src/types.ts';

function requireEscalation(inspection: LimiterInspection) {
	if (
		inspection.outcome !== 'ready' ||
		!inspection.penalty.configured ||
		!inspection.penalty.escalation.configured ||
		!inspection.penalty.escalation.supported
	) {
		throw new Error('expected inspectable penalty escalation state');
	}

	return inspection.penalty.escalation;
}

Deno.test('penalties escalate only on new strategy throttles and cap at maxPenaltyTime', async () => {
	await withFakeClock(async (clock) => {
		const storage = new MemoryStore(null);
		const escalations: Array<{ strikes: number; duration: number }> = [];
		const controlled = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 1, timeFrame: 10_000 })
				.limitFor('user')
				.withKeyPrefix('escalation:progression')
				.withPenalty({
					penaltyTime: 100,
					escalation: { factor: 2, maxPenaltyTime: 400, resetAfter: 2_000 },
				})
				.on('penaltyStrike', (_ctx, _key, strikes, duration) => {
					escalations.push({ strikes, duration });
				}),
		);
		const ctx = createTestContext({ userId: 21 });

		await controlled(ctx, async () => {}); // allowed
		await controlled(ctx, async () => {}); // strike 1
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);

		await controlled(ctx, async () => {}); // active penalty hit; must not add a strike
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);

		clock.advance(101);
		await controlled(ctx, async () => {}); // strike 2
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 2);

		clock.advance(201);
		await controlled(ctx, async () => {}); // strike 3 => cap 400
		clock.advance(401);
		await controlled(ctx, async () => {}); // strike 4 => still cap 400

		assertEquals(escalations, [
			{ strikes: 1, duration: 100 },
			{ strikes: 2, duration: 200 },
			{ strikes: 3, duration: 400 },
			{ strikes: 4, duration: 400 },
		]);
	});
});

Deno.test('strike history expires after resetAfter inactivity', async () => {
	await withFakeClock(async (clock) => {
		const storage = new MemoryStore(null);
		const controlled = limit(
			new Limiter()
				.useStorage(storage)
				.fixedWindow({ limit: 1, timeFrame: 10_000 })
				.limitFor('user')
				.withKeyPrefix('escalation:expiry')
				.withPenalty({
					penaltyTime: 100,
					escalation: { maxPenaltyTime: 1_000, resetAfter: 1_000 },
				}),
		);
		const ctx = createTestContext({ userId: 22 });

		await controlled(ctx, async () => {});
		await controlled(ctx, async () => {});
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);

		clock.advance(1_001);
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 0);
		await controlled(ctx, async () => {});
		assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);
	});
});

Deno.test('clearPenalty and clearStrikes remain independent administrative controls', async () => {
	const storage = new MemoryStore(null);
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('escalation:controls')
			.withPenalty({
				penaltyTime: 5_000,
				escalation: { factor: 2, maxPenaltyTime: 20_000, resetAfter: 60_000 },
			}),
	);
	const ctx = createTestContext({ userId: 23 });

	await controlled(ctx, async () => {});
	await controlled(ctx, async () => {});
	assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);

	assertEquals(await controlled.clearStrikes(ctx), true);

	let inspection = await controlled.inspect(ctx);

	assertEquals(requireEscalation(inspection).strikes, 0);

	if (inspection.outcome !== 'ready' || !inspection.penalty.configured) {
		throw new Error('expected penalty state');
	}

	assertEquals(inspection.penalty.active, true);

	assertEquals(await controlled.clearPenalty(ctx), true);
	inspection = await controlled.inspect(ctx);

	if (inspection.outcome !== 'ready' || !inspection.penalty.configured) {
		throw new Error('expected penalty state');
	}

	assertEquals(inspection.penalty.active, false);
	await controlled(ctx, async () => {});
	assertEquals(requireEscalation(await controlled.inspect(ctx)).strikes, 1);
});

Deno.test('penalty escalation fails fast when a custom store lacks the atomic capability', () => {
	const storage = new MemoryStore(null);

	Object.defineProperty(storage, 'applyEscalatingPenalty', { value: undefined });

	assertThrows(
		() =>
			limit(
				new Limiter()
					.useStorage(storage)
					.fixedWindow({ limit: 1, timeFrame: 1_000 })
					.limitFor('user')
					.withKeyPrefix('escalation:unsupported')
					.withPenalty({
						penaltyTime: 100,
						escalation: { maxPenaltyTime: 1_000, resetAfter: 10_000 },
					}),
			),
		Error,
		'penalty escalation requires storage.applyEscalatingPenalty()',
	);
});

Deno.test('dynamic base penalties can grow immediately but cannot weaken remembered escalation', async () => {
	const storage = new MemoryStore(null);
	const durations: number[] = [];
	let basePenaltyTime = 100;
	const controlled = limit(
		new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 10_000 })
			.limitFor('user')
			.withKeyPrefix('escalation:dynamic-base')
			.withPenalty({
				penaltyTime: () => basePenaltyTime,
				escalation: { factor: 2, maxPenaltyTime: 400, resetAfter: 60_000 },
			})
			.on('penaltyApplied', (_ctx, _key, duration) => durations.push(duration)),
	);
	const ctx = createTestContext({ userId: 24 });

	await controlled(ctx, async () => {});
	await controlled(ctx, async () => {}); // strike 1 => 100
	await controlled.clearPenalty(ctx);

	basePenaltyTime = 1_000;
	await controlled(ctx, async () => {}); // strike 2 => dynamic base jumps above configured max
	await controlled.clearPenalty(ctx);

	basePenaltyTime = 100;
	await controlled(ctx, async () => {}); // strike 3 must not fall back below 1_000

	assertEquals(durations, [100, 1_000, 1_000]);

	const escalation = requireEscalation(await controlled.inspect(ctx));

	assertEquals(escalation.lastPenaltyTime, 1_000);
});
