import { limit, Limiter } from '../mod.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { GrammyContext, NextFunction } from '../src/types.ts';

const createMockCtx = (fromId: number): GrammyContext => ({
	from: { id: fromId, is_bot: false, first_name: 'test' },
	chat: { id: fromId, type: 'private', first_name: 'test' },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createMemoryStore = () => new MemoryStore(null);

Deno.test('Core Rate Limiter Tests', async (t) => {
	await t.step('Builder should throw if essential components are missing', async () => {
		await assertRejects(
			// deno-lint-ignore require-await
			async () => new Limiter().build(),
			Error,
			'A limiting strategy must be defined',
		);

		await assertRejects(
			// deno-lint-ignore require-await
			async () => new Limiter().fixedWindow({ limit: 1, timeFrame: 1000 }).build(),
			Error,
			'A storage engine must be provided',
		);

		await assertRejects(
			// deno-lint-ignore require-await
			async () =>
				new Limiter().fixedWindow({ limit: 1, timeFrame: 1000 }).useStorage(
					createMemoryStore(),
				).build(),
			Error,
			'A key generation strategy must be defined',
		);
	});

	await t.step('FixedWindowStrategy should limit requests correctly', async () => {
		const storage = createMemoryStore();
		const limiter = new Limiter().useStorage(storage).fixedWindow({ limit: 2, timeFrame: 1000 })
			.limitFor('user');

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		await middleware(createMockCtx(100), next);
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 2);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 2);

		await middleware(createMockCtx(200), next);
		assertEquals(nextCalled, 3);

		await sleep(1100);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 4);
	});

	await t.step('TokenBucketStrategy should handle bursts and refills', async () => {
		const storage = createMemoryStore();
		const limiter = new Limiter()
			.useStorage(storage)
			.tokenBucket({ bucketSize: 3, tokensPerInterval: 1, interval: 1000 })
			.limitFor('user');

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		await middleware(createMockCtx(100), next);
		await middleware(createMockCtx(100), next);
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 3);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 3);

		await sleep(1100);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 4);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 4);
	});

	await t.step('onThrottled handler should be called', async () => {
		let throttled = false;
		const limiter = new Limiter()
			.useStorage(createMemoryStore())
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('user')
			.onThrottled(() => {
				throttled = true;
			});

		const middleware = limit(limiter);
		const next: NextFunction = () => Promise.resolve();

		await middleware(createMockCtx(100), next);
		assert(!throttled, 'onThrottled should not be called for allowed request');

		await middleware(createMockCtx(100), next);
		assert(throttled, 'onThrottled should have been called');
	});

	await t.step('PenaltyBox should mute a user', async () => {
		const storage = createMemoryStore();
		const limiter = new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 1000 });

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1);

		await sleep(1100);

		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 2);
	});

	await t.step('onlyIf() should conditionally apply the limiter', async () => {
		const storage = createMemoryStore();
		// Only limit users with ID 100
		const limiter = new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('user')
			.onlyIf((ctx) => ctx.from?.id === 100);

		const middleware = limit(limiter);
		let nextCalled = 0;

		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		// User 200 should not be limited at all
		await middleware(createMockCtx(200), next);
		await middleware(createMockCtx(200), next);
		assertEquals(nextCalled, 2);

		// User 100 should be limited
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 3);
		// Second call for user 100 should be throttled
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 3);
	});

	await t.step('FixedWindow should support dynamic limits', async () => {
		const storage = createMemoryStore();
		const isAdmin = (ctx: GrammyContext) => ctx.from?.id === 200; // User 200 is an admin

		const limiter = new Limiter()
			.useStorage(storage)
			.fixedWindow({
				// Admins get 5 requests, others get 1
				limit: (ctx) => (isAdmin(ctx) ? 5 : 1),
				timeFrame: 1000,
			})
			.limitFor('user');

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		// Regular user (ID 100)
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1);
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1); // Throttled

		// Admin user (ID 200)
		await middleware(createMockCtx(200), next);
		await middleware(createMockCtx(200), next);
		assertEquals(nextCalled, 3);
	});

	await t.step("limitFor('global') should apply the same limit to all users", async () => {
		const storage = createMemoryStore();
		const limiter = new Limiter().useStorage(storage).fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('global');

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		// First call from user 100
		await middleware(createMockCtx(100), next);
		assertEquals(nextCalled, 1);

		// Second call from a DIFFERENT user (200) should be throttled
		await middleware(createMockCtx(200), next);
		assertEquals(nextCalled, 1);
	});

	await t.step('Event emitters for "allowed" and "penaltyApplied" should fire', async () => {
		let allowedFired = false;
		let penaltyFired = false;
		let throttledFired = false;

		const limiter = new Limiter()
			.useStorage(createMemoryStore())
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('user')
			.withPenalty({ penaltyTime: 5000 });

		limiter.on('allowed', () => (allowedFired = true));
		limiter.on('throttled', () => (throttledFired = true));
		limiter.on('penaltyApplied', () => (penaltyFired = true));

		const middleware = limit(limiter);
		const next: NextFunction = () => Promise.resolve();

		// First call should trigger 'allowed'
		await middleware(createMockCtx(100), next);
		assert(allowedFired, '"allowed" event did not fire');
		assert(!throttledFired, '"throttled" should not have fired yet');
		assert(!penaltyFired, '"penaltyApplied" should not have fired yet');

		// Second call should trigger 'throttled' and 'penaltyApplied'
		await middleware(createMockCtx(100), next);
		assert(throttledFired, '"throttled" event did not fire');
		assert(penaltyFired, '"penaltyApplied" event did not fire');
	});

	await t.step('Custom key generator should create separate limits', async () => {
		interface ContextWithCommand extends GrammyContext {
			message?: {
				text?: string;
			};
		}

		const storage = createMemoryStore();
		const limiter = new Limiter<ContextWithCommand>()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor((ctx) => {
				const userId = ctx.from?.id;
				// This is now fully type-safe, no `any` cast needed.
				const command = ctx.message?.text?.split(' ')[0];
				return userId && command ? `${userId}:${command}` : undefined;
			});

		const middleware = limit(limiter);
		let nextCalled = 0;
		const next: NextFunction = () => {
			nextCalled++;
			return Promise.resolve();
		};

		const baseCtx = createMockCtx(100);

		// First call for user 100 on /start
		await middleware({ ...baseCtx, message: { text: '/start' } }, next);
		assertEquals(nextCalled, 1);

		// Second call for user 100 on /start should be throttled
		await middleware({ ...baseCtx, message: { text: '/start' } }, next);
		assertEquals(nextCalled, 1);

		// But a call for the same user on /help should pass
		await middleware({ ...baseCtx, message: { text: '/help' } }, next);
		assertEquals(nextCalled, 2);
	});

	await t.step('PenaltyBox should support dynamic penalty time', async () => {
		const storage = createMemoryStore();
		const limiter = new Limiter()
			.useStorage(storage)
			.fixedWindow({ limit: 1, timeFrame: 1000 })
			.limitFor('user')
			.withPenalty({
				// Penalty is 1000ms times the number of remaining "hits" below zero
				penaltyTime: (_ctx, info) => 1000 * Math.abs(info.remaining),
			});

		const middleware = limit(limiter);
		const next: NextFunction = () => Promise.resolve();

		await middleware(createMockCtx(100), next); // remaining: 0, allowed
		await middleware(createMockCtx(100), next); // remaining: -1, throttled, penalty applied for 1000ms

		// This third call should be ignored due to the penalty
		let penaltyCheck = false;
		await middleware(createMockCtx(100), () => {
			penaltyCheck = true; // This should not be called
			return Promise.resolve();
		});
		assert(!penaltyCheck);

		// Wait for the penalty to expire
		await sleep(1100);

		// The user should be able to make a request again
		await middleware(createMockCtx(100), next); // This works
		const wasPenalized = await storage.checkPenalty('GRAMMY:RATELIMITER:PENALTY:100');
		assert(!wasPenalized, 'Penalty key should have expired');
	});
});
