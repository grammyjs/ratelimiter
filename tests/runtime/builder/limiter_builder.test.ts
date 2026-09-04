import { Limiter } from '../../../src/core/builder.ts';
import { limit } from '../../../src/core/middleware.ts';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { createTestContext } from '../../support/context.ts';
import { defineLimiterPreset } from '../../../src/core/preset.ts';
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import type { GrammyContext } from '../../../src/types.ts';

const createStore = () => new MemoryStore(null);

Deno.test('Limiter.build rejects incomplete rules at the boundary', async () => {
	await assertRejects(
		// deno-lint-ignore require-await
		async () => new Limiter().build(),
		Error,
		'A limiting strategy must be defined',
	);

	await assertRejects(
		// deno-lint-ignore require-await
		async () => new Limiter().fixedWindow({ limit: 1, timeFrame: 1_000 }).build(),
		Error,
		'A storage engine must be provided',
	);

	await assertRejects(
		// deno-lint-ignore require-await
		async () =>
			new Limiter()
				.fixedWindow({ limit: 1, timeFrame: 1_000 })
				.useStorage(createStore())
				.build(),
		Error,
		'A key generation strategy must be defined',
	);
});

Deno.test('Limiter validates key and penalty configuration eagerly', () => {
	assertThrows(() => new Limiter().withKeyPrefix(''), Error, 'key prefix must not be empty');
	assertThrows(
		() => new Limiter().withPenalty({ penaltyTime: Number.POSITIVE_INFINITY }),
		Error,
		'finite, non-negative',
	);
	assertThrows(
		() => new Limiter().withPenalty({ penaltyTime: 1_000, penaltyKeyPrefix: '' }),
		Error,
		'penalty key prefix must not be empty',
	);
	assertThrows(
		() =>
			new Limiter().withPenalty({
				penaltyTime: 1_000,
				escalation: { factor: 1, maxPenaltyTime: 10_000, resetAfter: 60_000 },
			}),
		Error,
		'factor must be finite and greater than 1',
	);
	assertThrows(
		() =>
			new Limiter().withPenalty({
				penaltyTime: 1_000,
				escalation: { maxPenaltyTime: 0, resetAfter: 60_000 },
			}),
		Error,
		'maxPenaltyTime must be a finite positive number',
	);
	assertThrows(
		() =>
			new Limiter().withPenalty({
				penaltyTime: 1_000,
				escalation: { maxPenaltyTime: 10_000, resetAfter: 1.5 },
			}),
		Error,
		'resetAfter must be a positive integer',
	);
});

Deno.test('Limiter derives default penalty namespaces from the final rule key prefix', () => {
	const derived = new Limiter()
		.withPenalty({ penaltyTime: 1_000 })
		.withKeyPrefix('derived-penalty')
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.build();
	const escalating = new Limiter()
		.withPenalty({
			penaltyTime: 1_000,
			escalation: { maxPenaltyTime: 8_000, resetAfter: 60_000 },
		})
		.withKeyPrefix('derived-escalation')
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.build();
	const explicit = new Limiter()
		.withKeyPrefix('ignored-for-penalty')
		.withPenalty({ penaltyTime: 1_000, penaltyKeyPrefix: 'shared-penalty' })
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.build();

	assertEquals(derived.penalty?.keyPrefix, 'derived-penalty:PENALTY');
	assertEquals(explicit.penalty?.keyPrefix, 'shared-penalty');
	assertEquals(escalating.penalty?.escalation, {
		factor: 2,
		maxPenaltyTime: 8_000,
		resetAfter: 60_000,
		keyPrefix: 'derived-escalation:PENALTY:STRIKES',
	});
});

Deno.test('Limiter.build snapshots event registrations', async () => {
	let originalCalls = 0;
	let lateCalls = 0;
	const original = () => {
		originalCalls += 1;
	};

	const builder = new Limiter()
		.withKeyPrefix('snapshot')
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.on('allowed', original);

	const rule = builder.build();

	builder.off('allowed', original).on('allowed', () => {
		lateCalls += 1;
	});

	await limit(rule)(createTestContext(), () => Promise.resolve());
	assertEquals(originalCalls, 1);
	assertEquals(lateCalls, 0);
});

Deno.test('Limiter names rules for observability without affecting storage identity', () => {
	assertThrows(() => new Limiter().withName('   '), Error, 'rule name must not be empty');

	const rule = new Limiter()
		.withName('user-messages')
		.withKeyPrefix('named-rule')
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.build();

	assertEquals(rule.name, 'user-messages');
	assertEquals(rule.keyPrefix, 'named-rule');
});

Deno.test('Limiter scope presets match explicit scope key semantics', () => {
	const storage = createStore();
	const build = (builder: Limiter<GrammyContext>) =>
		builder
			.withKeyPrefix('preset-test')
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1_000 })
			.build();

	const ctx = createTestContext({ userId: 42, chatId: -100 });
	const other = createTestContext({ userId: 7, chatId: -200 });
	const missingUser = { chat: ctx.chat } as unknown as GrammyContext;
	const missingChat = { from: ctx.from } as unknown as GrammyContext;

	assertEquals(build(Limiter.perUser()).keyGenerator(ctx), '42');
	assertEquals(build(Limiter.perUser()).keyGenerator(missingUser), undefined);
	assertEquals(build(Limiter.perChat()).keyGenerator(ctx), '-100');
	assertEquals(build(Limiter.perChat()).keyGenerator(missingChat), undefined);
	assertEquals(build(Limiter.perUserPerChat()).keyGenerator(ctx), '42:-100');
	assertEquals(build(Limiter.perUserPerChat()).keyGenerator(missingUser), undefined);
	assertEquals(build(Limiter.perUserPerChat()).keyGenerator(missingChat), undefined);
	assertEquals(
		build(Limiter.global()).keyGenerator(ctx),
		build(Limiter.global()).keyGenerator(other),
	);
});

Deno.test('reusable limiter presets create isolated fresh builders', () => {
	const storage = createStore();
	let factoryCalls = 0;
	const preset = defineLimiterPreset(() => {
		factoryCalls += 1;

		return Limiter.perUser()
			.useStorage(storage)
			.fixedWindow({ limit: 2, timeFrame: 1_000 })
			.withKeyPrefix('preset:anti-spam');
	});

	const first = preset.apply().withName('first').build();
	const second = preset.apply().withName('second').build();

	assertEquals(factoryCalls, 2);
	assertEquals(first.name, 'first');
	assertEquals(second.name, 'second');
	assertEquals(first.keyPrefix, 'preset:anti-spam');
	assertEquals(second.keyPrefix, 'preset:anti-spam');
});

Deno.test('reusable limiter presets reject factories that recycle a builder', () => {
	const shared = Limiter.perUser()
		.useStorage(createStore())
		.fixedWindow({ limit: 1, timeFrame: 1_000 });
	const preset = defineLimiterPreset(() => shared);

	preset.apply();
	assertThrows(
		() => preset.apply(),
		Error,
		'preset factory must return a fresh Limiter builder',
	);
});
