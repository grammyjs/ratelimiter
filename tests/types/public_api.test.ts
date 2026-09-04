import { type IRedisClient, MemoryStore, RedisStore } from '../../storages.ts';
import type { Context, MiddlewareFn } from '@grammyjs/grammy';

import {
	type AtomicLimitOperation,
	type CooldownDurationGenerator,
	defineLimiterPreset,
	FixedWindowStrategy,
	type GcraOptions,
	GcraStrategy,
	type IAtomicLimitStorage,
	type IFixedWindowStorage,
	type IGcraStorage,
	type ILimiterInspectionStorage,
	type ILimiterRefundStorage,
	type ILimiterStrategy,
	type IPenaltyEscalationStorage,
	type IPenaltyStorage,
	type ISlidingWindowStorage,
	type IStateStorage,
	type IStorageEngine,
	type ITokenBucketStorage,
	limit,
	limitAll,
	limitAllAtomic,
	Limiter,
	type LimiterCompositeDiagnostic,
	type LimiterCompositeMiddleware,
	type LimiterConsumer,
	type LimiterConsumeResult,
	type LimiterDecision,
	type LimiterDiagnostic,
	type LimiterInspection,
	type LimiterMetric,
	type LimiterMetricSource,
	type LimiterMiddleware,
	type LimiterMode,
	type LimiterPreset,
	type LimiterRefunder,
	type LimitResult,
	type PenaltyOptions,
	type SlidingWindowOptions,
	SlidingWindowStrategy,
	type StorageFailureMode,
	type TokenBucketOptions,
	type TokenCostGenerator,
} from '../../mod.ts';

type TenantFlavor<C extends Context> = C & {
	tenantId: string;
};

declare const storage: IStorageEngine;
declare const redisClient: IRedisClient;

const flavoredLimiter = new Limiter<TenantFlavor<Context>>()
	.withName('tenant-messages')
	.withKeyPrefix('types')
	.useStorage(storage)
	.fixedWindow({
		limit: (ctx) => ctx.tenantId === 'internal' ? 10 : 2,
		timeFrame: 1_000,
	})
	.limitFor((ctx) => `${ctx.tenantId}:${ctx.from?.id ?? 'anonymous'}`)
	.onlyIf((ctx) => ctx.tenantId.length > 0)
	.withPenalty({
		penaltyTime: (ctx, info) => ctx.tenantId === 'internal' ? info.reset : 1_000,
		escalation: { factor: 2, maxPenaltyTime: 60_000, resetAfter: 300_000 },
	})
	.withStorageFailurePolicy((ctx, info) => {
		const tenant: string = ctx.tenantId;
		const operation: string = info.operation;

		void tenant;
		void operation;

		return Promise.resolve(info.phase === 'strategy-check' ? 'fail-open' : 'throw');
	})
	.on('allowed', (ctx, info) => {
		const tenant: string = ctx.tenantId;
		const remaining: number = info.remaining;

		void tenant;
		void remaining;
	})
	.on('bypassed', (_ctx, info) => {
		const reason: 'filter' | 'missing-key' | 'storage-failure' = info.reason;

		void reason;
	})
	.on('penaltyHit', (_ctx, entityKey) => {
		const key: string = entityKey;

		void key;
	})
	.on('penaltyStrike', (ctx, entityKey, strikes, duration) => {
		const tenant: string = ctx.tenantId;
		const key: string = entityKey;
		const strikeCount: number = strikes;
		const penaltyDuration: number = duration;

		void tenant;
		void key;
		void strikeCount;
		void penaltyDuration;
	})
	.on('storageError', (_ctx, info) => {
		const phase: 'penalty-check' | 'strategy-check' | 'penalty-write' | 'composite-check' =
			info.phase;

		void phase;
	})
	.on('decision', (ctx, decision) => {
		const tenant: string = ctx.tenantId;
		const mode: LimiterMode = decision.mode;
		const typedDecision: LimiterDecision = decision;
		const ruleName: string | undefined = decision.ruleName;

		void ruleName;

		if (decision.outcome === 'throttled') {
			const reset: number = decision.result.reset;
			const storageKey: string = decision.storageKey;

			void reset;
			void storageKey;
		}

		void tenant;
		void mode;
		void typedDecision;
	})
	.on('metric', (ctx, metric) => {
		const tenant: string = ctx.tenantId;
		const typedMetric: LimiterMetric = metric;
		const source: LimiterMetricSource = metric.source;
		const duration: number = metric.durationMs;

		if (metric.kind === 'decision') {
			const outcome = metric.decision.outcome;

			void outcome;
		} else {
			const outcome: 'succeeded' | 'unsupported' | 'failed' = metric.outcome;

			void outcome;
		}

		void tenant;
		void typedMetric;
		void source;
		void duration;
	});

const builtNamedRule = flavoredLimiter.build();
const builtRuleName: string | undefined = builtNamedRule.name;

void builtRuleName;

const controlledMiddleware: LimiterMiddleware<TenantFlavor<Context>> = limit(builtNamedRule);
const manualConsumer: LimiterConsumer<TenantFlavor<Context>> = controlledMiddleware;
const manualRefunder: LimiterRefunder = controlledMiddleware;
const manualConsumeResult: Promise<LimiterConsumeResult> = manualConsumer.consume(
	{} as TenantFlavor<Context>,
);

void manualConsumeResult;
void manualRefunder;

const middleware: MiddlewareFn<TenantFlavor<Context>> = controlledMiddleware;
const inspection: Promise<LimiterInspection> = controlledMiddleware.inspect(
	{} as TenantFlavor<Context>,
);

inspection.then((value) => {
	const ruleName: string | undefined = value.ruleName;

	void ruleName;
});

const resetResult: Promise<boolean> = controlledMiddleware.reset({} as TenantFlavor<Context>);
const clearPenaltyResult: Promise<boolean> = controlledMiddleware.clearPenalty(
	{} as TenantFlavor<Context>,
);
const clearStrikesResult: Promise<boolean> = controlledMiddleware.clearStrikes(
	{} as TenantFlavor<Context>,
);

void middleware;
void inspection;
void resetResult;
void clearPenaltyResult;
void clearStrikesResult;

const observedMiddleware: MiddlewareFn<TenantFlavor<Context>> = limit(
	new Limiter<TenantFlavor<Context>>()
		.withKeyPrefix('types:observe')
		.useStorage(storage)
		.gcra({ rate: 5, interval: 1_000, burst: 10 })
		.limitFor((ctx) => ctx.tenantId)
		.observeOnly()
		.on('decision', (_ctx, decision) => {
			const mode: 'enforce' | 'observe' = decision.mode;

			void mode;
		}),
);

void observedMiddleware;

const layeredMiddleware: MiddlewareFn<TenantFlavor<Context>> = limitAll(
	new Limiter<TenantFlavor<Context>>()
		.withKeyPrefix('types:user')
		.useStorage(storage)
		.fixedWindow({ limit: 5, timeFrame: 1_000 })
		.limitFor('user'),
	new Limiter<TenantFlavor<Context>>()
		.withKeyPrefix('types:tenant')
		.useStorage(storage)
		.gcra({ rate: 20, interval: 1_000, burst: 40 })
		.limitFor((ctx) => ctx.tenantId),
);

void layeredMiddleware;

const atomicLayeredMiddleware: MiddlewareFn<TenantFlavor<Context>> = limitAllAtomic(
	new Limiter<TenantFlavor<Context>>()
		.withKeyPrefix('types:atomic:user')
		.useStorage(storage)
		.fixedWindow({ limit: 5, timeFrame: 1_000 })
		.limitFor('user'),
	new Limiter<TenantFlavor<Context>>()
		.withKeyPrefix('types:atomic:tenant')
		.useStorage(storage)
		.tokenBucket({ bucketSize: 20, tokensPerInterval: 5, interval: 1_000 })
		.limitFor((ctx) => ctx.tenantId),
);

void atomicLayeredMiddleware;

const atomicOperation: AtomicLimitOperation = new FixedWindowStrategy({
	limit: 2,
	timeFrame: 1_000,
}).toAtomicOperation('atomic-key');

void atomicOperation;

const strategy: ILimiterStrategy = new FixedWindowStrategy({ limit: 2, timeFrame: 1_000 });
const result: Promise<LimitResult> = strategy.check('key', storage);
const previewResult: Promise<LimitResult | undefined> | undefined = strategy.preview?.(
	'key',
	storage,
);
const strategyResetResult: Promise<void> | undefined = strategy.reset?.('key', storage);

void result;
void previewResult;
void strategyResetResult;

const memoryStorage: IStorageEngine = new MemoryStore(null);
const redisStorage: IStorageEngine = new RedisStore(redisClient);

void memoryStorage;
void redisStorage;

const stateCapability: IStateStorage = memoryStorage;
const atomicLimitCapability: IAtomicLimitStorage = new MemoryStore(null);
const fixedWindowCapability: IFixedWindowStorage = memoryStorage;
const slidingWindowCapability: ISlidingWindowStorage = memoryStorage;
const tokenBucketCapability: ITokenBucketStorage = memoryStorage;
const gcraCapability: IGcraStorage = memoryStorage;
const penaltyCapability: IPenaltyStorage = memoryStorage;
const penaltyEscalationCapability: IPenaltyEscalationStorage = new MemoryStore(null);
const redisPenaltyEscalationCapability: IPenaltyEscalationStorage = new RedisStore(redisClient);
const inspectionCapability: ILimiterInspectionStorage = memoryStorage;
const refundCapability: ILimiterRefundStorage = memoryStorage;

void stateCapability;
void atomicLimitCapability;
void fixedWindowCapability;
void slidingWindowCapability;
void tokenBucketCapability;
void gcraCapability;
void penaltyCapability;
void penaltyEscalationCapability;
void redisPenaltyEscalationCapability;
void inspectionCapability;
void refundCapability;

const failureMode: StorageFailureMode = 'fail-open';

void failureMode;

const penaltyOptions: PenaltyOptions<TenantFlavor<Context>> = {
	penaltyTime: (ctx) => ctx.tenantId === 'internal' ? 5_000 : 1_000,
	escalation: { maxPenaltyTime: 60_000, resetAfter: 300_000 },
};

new Limiter<TenantFlavor<Context>>().withPenalty(penaltyOptions);

new Limiter<Context>().withPenalty({
	penaltyTime: 1_000,
	escalation: {
		// @ts-expect-error escalation factor must be numeric.
		factor: 'double',
		maxPenaltyTime: 60_000,
		resetAfter: 300_000,
	},
});

// @ts-expect-error predefined scopes are intentionally closed and autocomplete-safe
new Limiter<Context>().limitFor('message');

// @ts-expect-error custom key generators must return a string or undefined
new Limiter<Context>().limitFor(() => 42);

// @ts-expect-error event names are strongly typed
flavoredLimiter.on('blocked', () => {});

flavoredLimiter.onThrottled(async (_ctx, info) => {
	await Promise.resolve(info.reset);
});

// @ts-expect-error custom strategies must implement check()
new Limiter<Context>().customStrategy({});

// @ts-expect-error storage failure modes are intentionally closed and autocomplete-safe
new Limiter<Context>().withStorageFailurePolicy('ignore');

// @ts-expect-error policy resolvers must return a documented mode
new Limiter<Context>().withStorageFailurePolicy(() => 'maybe');

const tokenCost: TokenCostGenerator<TenantFlavor<Context>> = (ctx) =>
	ctx.tenantId === 'internal' ? 3 : 1;

const dynamicTokenOptions: TokenBucketOptions<TenantFlavor<Context>> = {
	bucketSize: (ctx) => ctx.tenantId === 'internal' ? 20 : 5,
	tokensPerInterval: 2,
	interval: (ctx) => ctx.tenantId.length > 0 ? 1_000 : 2_000,
	cost: tokenCost,
};

new Limiter<TenantFlavor<Context>>()
	.withKeyPrefix('dynamic-token-types')
	.useStorage(storage)
	.tokenBucket(dynamicTokenOptions)
	.limitFor('user');

new Limiter<TenantFlavor<Context>>().tokenBucket({
	// @ts-expect-error Token Bucket generators must resolve to numbers.
	bucketSize: () => 'large',
	tokensPerInterval: 1,
	interval: 1_000,
});

const gcraStrategy: ILimiterStrategy = new GcraStrategy({
	rate: 5,
	interval: 1_000,
	burst: 10,
	cost: 2,
});

void gcraStrategy;

const cooldownDuration: CooldownDurationGenerator<TenantFlavor<Context>> = (ctx) =>
	ctx.tenantId === 'internal' ? 250 : 1_000;

new Limiter<TenantFlavor<Context>>()
	.withKeyPrefix('cooldown-types')
	.useStorage(storage)
	.cooldown(cooldownDuration)
	.limitFor('user');

new Limiter<TenantFlavor<Context>>().cooldown(
	// @ts-expect-error cooldown duration resolvers must return numbers.
	() => 'soon',
);

const dynamicGcraOptions: GcraOptions<TenantFlavor<Context>> = {
	rate: (ctx) => ctx.tenantId === 'internal' ? 20 : 5,
	interval: 1_000,
	burst: (ctx) => ctx.tenantId === 'internal' ? 40 : 10,
	cost: (ctx) => ctx.tenantId === 'internal' ? 4 : 1,
};

new Limiter<TenantFlavor<Context>>()
	.withKeyPrefix('dynamic-gcra-types')
	.useStorage(storage)
	.gcra(dynamicGcraOptions)
	.limitFor('user');

new Limiter<TenantFlavor<Context>>().gcra({
	rate: 5,
	interval: 1_000,
	// @ts-expect-error GCRA generators must resolve to numbers.
	burst: () => 'large',
});

const slidingStrategy: ILimiterStrategy = new SlidingWindowStrategy({
	limit: 10,
	timeFrame: 1_000,
	cost: 2,
});

void slidingStrategy;

const dynamicSlidingOptions: SlidingWindowOptions<TenantFlavor<Context>> = {
	limit: (ctx) => ctx.tenantId === 'internal' ? 20 : 5,
	timeFrame: 1_000,
	cost: (ctx) => ctx.tenantId === 'internal' ? 4 : 1,
};

new Limiter<TenantFlavor<Context>>()
	.withKeyPrefix('dynamic-sliding-types')
	.useStorage(storage)
	.slidingWindow(dynamicSlidingOptions)
	.limitFor('user');

new Limiter<TenantFlavor<Context>>().slidingWindow({
	// @ts-expect-error Sliding Window generators must resolve to numbers.
	limit: () => 'large',
	timeFrame: 1_000,
});

new Limiter<TenantFlavor<Context>>().slidingWindow({
	limit: 5,
	// @ts-expect-error Sliding Window timeFrame is static so persisted bucket geometry stays stable.
	timeFrame: () => 1_000,
});

const metadataLimiter = new Limiter<TenantFlavor<Context>>()
	.withMetadata((ctx) => ({ tenantId: ctx.tenantId, plan: 'pro' as const }))
	.withName('metadata-types')
	.withKeyPrefix('types:metadata')
	.useStorage(storage)
	.fixedWindow({ limit: 5, timeFrame: 1_000 })
	.limitFor('user')
	.on('decision', (_ctx, decision) => {
		const userId: number | undefined = decision.metadata.userId;
		const chatId: number | undefined = decision.metadata.chatId;
		const tenantId: string | undefined = decision.metadata.custom?.tenantId;
		const plan: 'pro' | undefined = decision.metadata.custom?.plan;

		void userId;
		void chatId;
		void tenantId;
		void plan;
	});

const metadataMiddleware = limit(metadataLimiter);

metadataMiddleware.inspect({} as TenantFlavor<Context>).then((value) => {
	const tenantId: string | undefined = value.metadata.custom?.tenantId;

	void tenantId;
});

new Limiter<TenantFlavor<Context>>()
	.withMetadata()
	.on('decision', (_ctx, decision) => {
		const userId: number | undefined = decision.metadata.userId;

		void userId;
	});

controlledMiddleware.consume({} as TenantFlavor<Context>).then((value) => {
	const isAllowed: boolean = value.isAllowed;
	const mode: LimiterMode = value.mode;

	void isAllowed;
	void mode;
});

metadataMiddleware.consume({} as TenantFlavor<Context>).then((value) => {
	const tenantId: string | undefined = value.metadata.custom?.tenantId;
	const userId: number | undefined = value.metadata.userId;

	void tenantId;
	void userId;
});

controlledMiddleware.consume({} as TenantFlavor<Context>).then(async (value) => {
	const refunded: boolean = await controlledMiddleware.refund(value);
	const scheduled: boolean = controlledMiddleware.refundBestEffort(value);

	void refunded;
	void scheduled;
});

metadataMiddleware.consume({} as TenantFlavor<Context>).then(async (value) => {
	const refunded: boolean = await metadataMiddleware.refund(value);

	void refunded;
});

const perUserPreset = Limiter.perUser<TenantFlavor<Context>>()
	.useStorage(storage)
	.fixedWindow({ limit: (ctx) => ctx.tenantId === 'internal' ? 10 : 2, timeFrame: 1_000 });
const perChatPreset = Limiter.perChat<TenantFlavor<Context>>();
const perUserPerChatPreset = Limiter.perUserPerChat<TenantFlavor<Context>>();
const globalPreset = Limiter.global<TenantFlavor<Context>>();

void perUserPreset;
void perChatPreset;
void perUserPerChatPreset;
void globalPreset;

const reusablePreset = defineLimiterPreset(() =>
	Limiter.perUser<TenantFlavor<Context>>()
		.withMetadata((ctx) => ({ tenantId: ctx.tenantId }))
		.useStorage(storage)
		.fixedWindow({ limit: 3, timeFrame: 1_000 })
);
const typedPreset: LimiterPreset<
	TenantFlavor<Context>,
	Readonly<{ tenantId: string }>
> = reusablePreset;
const reusableBuilder = reusablePreset.apply();

reusableBuilder.on('decision', (_ctx, decision) => {
	const tenantId: string | undefined = decision.metadata.custom?.tenantId;

	void tenantId;
});
void typedPreset;

metadataMiddleware.diagnose({} as TenantFlavor<Context>).then((diagnostic) => {
	const typed: LimiterDiagnostic<Readonly<{ tenantId: string; plan: 'pro' }>> = diagnostic;
	const tenantId: string | undefined = diagnostic.metadata.custom?.tenantId;
	const wouldContinue: boolean | undefined = diagnostic.wouldContinue;

	if (diagnostic.outcome === 'would-allow' || diagnostic.outcome === 'would-throttle') {
		const strategyKind:
			| 'fixed-window'
			| 'sliding-window'
			| 'token-bucket'
			| 'gcra'
			| 'cooldown'
			| 'custom' = diagnostic.strategy.kind;
		const remaining: number = diagnostic.strategy.result.remaining;

		void strategyKind;
		void remaining;
	}

	void typed;
	void tenantId;
	void wouldContinue;
});

const diagnosticComposite: LimiterCompositeMiddleware<TenantFlavor<Context>> = limitAll(
	reusablePreset.apply().withName('first'),
	reusablePreset.apply().withName('second').withKeyPrefix('types:preset:second'),
);

diagnosticComposite.diagnose({} as TenantFlavor<Context>).then((diagnostic) => {
	const typed: LimiterCompositeDiagnostic = diagnostic;

	if (diagnostic.outcome === 'would-block') {
		const blockingLayer: number = diagnostic.blockingLayer;

		void blockingLayer;
	}

	void typed;
});
