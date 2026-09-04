import type {
	Context,
	MiddlewareFn as GrammyMiddlewareFn,
	NextFunction as GrammyNextFunction,
} from '@grammyjs/grammy';

/**
 * The grammY context type accepted by this plugin.
 *
 * This aliases grammY's official `Context` type. Generic limiter APIs may use
 * transformed/flavoured context types as long as they remain assignable to
 * grammY's `Context`.
 */
export type GrammyContext = Context;

/** The downstream middleware function supplied by grammY. */
export type NextFunction = GrammyNextFunction;

// ==================== Storage Capabilities ====================

/**
 * Generic expiring state operations available to custom strategies.
 *
 * Values used with the built-in `RedisStore` must be JSON-serializable.
 */
export interface IStateStorage {
	/** Retrieves a value, or `undefined` when the key does not exist or has expired. */
	get<T>(key: string): Promise<T | undefined>;

	/** Stores a value with a time-to-live in milliseconds. */
	set<T>(key: string, state: T, ttl: number): Promise<void>;

	/** Deletes a key and its associated state. */
	delete(key: string): Promise<void>;
}

/** Result of an atomic fixed-window increment. */
export interface FixedWindowIncrementResult {
	/** Counter value after the current increment. */
	value: number;
	/** Milliseconds until the current fixed window expires. */
	reset: number;
}

/** Atomic storage capability required by `FixedWindowStrategy`. */
export interface IFixedWindowStorage {
	/**
	 * Atomically increments a fixed-window counter.
	 *
	 * Expiry must be assigned only when a new window is created. Later increments
	 * in that same window must not extend its expiry.
	 */
	increment(key: string, ttl: number): Promise<FixedWindowIncrementResult>;
}

/** Parameters required to atomically evaluate a Sliding Window Counter. */
export interface SlidingWindowConsumeOptions {
	/** Maximum cost units admitted by the rolling window. */
	limit: number;
	/** Sliding-window duration in milliseconds. */
	timeFrame: number;
	/** Cost units consumed by the current request. */
	cost: number;
}

/** Result of an atomic Sliding Window Counter evaluation. */
export type SlidingWindowConsumeResult = LimitResult;

/** Atomic storage capability required by `SlidingWindowStrategy`. */
export interface ISlidingWindowStorage {
	/**
	 * Atomically evaluates and, when allowed, consumes capacity from a bounded-memory
	 * Sliding Window Counter.
	 *
	 * Implementations must retain only the current and immediately previous fixed
	 * buckets for each key. The previous bucket is weighted by how much of the
	 * current window remains. Distributed stores should use backend/server time so
	 * multiple bot instances agree on bucket boundaries.
	 */
	consumeSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult>;
}

/**
 * Parameters required to atomically consume a token bucket.
 *
 * Built-in strategies validate these values before calling storage. Storage
 * implementations may therefore assume positive finite rates, a positive
 * integer interval, and `0 < cost <= bucketSize`.
 */
export interface TokenBucketConsumeOptions {
	/** Maximum number of tokens the bucket can hold. */
	bucketSize: number;
	/** Number of tokens replenished per `interval`. */
	tokensPerInterval: number;
	/** Refill interval in milliseconds. */
	interval: number;
	/** Tokens consumed by the current request. */
	cost: number;
	/** Storage TTL in milliseconds for the persisted bucket state. */
	ttl: number;
}

/** Result of an atomic token-bucket consumption operation. */
export interface TokenBucketConsumeResult {
	/** Whether the current request consumed its requested cost and may proceed. */
	isAllowed: boolean;
	/** Exact token balance after the current request, including fractional tokens. */
	tokens: number;
	/** Milliseconds until the requested cost is available again, or `0` if it is available now. */
	reset: number;
}

/** Atomic storage capability required by `TokenBucketStrategy`. */
export interface ITokenBucketStorage {
	/**
	 * Atomically refills a bucket and consumes the requested token cost.
	 *
	 * The read/refill/consume/write sequence must be one atomic operation for the
	 * supplied key. A simple `get` followed by `set` is not sufficient under
	 * concurrent or distributed execution.
	 */
	consumeTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult>;
}

/** Parameters required to atomically evaluate a GCRA limiter. */
export interface GcraConsumeOptions {
	/** Sustained number of cost units admitted per `interval`. */
	rate: number;
	/** Rate interval in milliseconds. */
	interval: number;
	/** Maximum cost units admitted immediately after the key is fully idle. */
	burst: number;
	/** Cost units consumed by the current request. */
	cost: number;
}

/** Result of an atomic GCRA evaluation. */
export type GcraConsumeResult = LimitResult;

/** Atomic storage capability required by `GcraStrategy`. */
export interface IGcraStorage {
	/**
	 * Atomically evaluates and, when allowed, advances one GCRA schedule.
	 *
	 * Implementations must use one authoritative clock for the entire operation.
	 * Distributed stores should use backend/server time rather than application
	 * process time so multiple bot instances cannot disagree because of clock skew.
	 */
	consumeGcra(key: string, options: GcraConsumeOptions): Promise<GcraConsumeResult>;
}

/**
 * Optional storage primitives used to compensate one successful manual consumption.
 *
 * These methods are optional so existing custom stores remain source-compatible.
 * Built-in strategies report refund support only when the corresponding primitive
 * exists. Implementations must preserve the strategy's existing expiry semantics
 * and restore one configured request cost atomically for the supplied key.
 */
export interface ILimiterRefundStorage {
	/**
	 * Restores one request only when the active Fixed Window still belongs to the
	 * original manual consumption.
	 *
	 * `maxReset` is the largest remaining TTL, in milliseconds, that the original
	 * window may still have. Implementations must refuse the refund when the current
	 * key has a larger TTL, which indicates that the key has rolled into a newer
	 * window. Returns whether capacity was actually restored.
	 */
	refundFixedWindow?(key: string, maxReset: number): Promise<boolean>;

	/** Restores one configured cost unit to the current Sliding Window state. */
	refundSlidingWindow?(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<void>;

	/** Refills current Token Bucket state and restores one configured request cost. */
	refundTokenBucket?(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<void>;

	/** Restores one configured request cost to the current GCRA schedule. */
	refundGcra?(key: string, options: GcraConsumeOptions): Promise<void>;
}

/** Atomic Fixed Window operation used by `limitAllAtomic()`. */
export interface AtomicFixedWindowOperation {
	/** Strategy discriminant. */
	readonly kind: 'fixed-window';
	/** Fully resolved strategy storage key. */
	readonly key: string;
	/** Maximum requests allowed during the window. */
	readonly limit: number;
	/** Window duration in milliseconds. */
	readonly timeFrame: number;
}

/** Atomic Sliding Window operation used by `limitAllAtomic()`. */
export interface AtomicSlidingWindowOperation {
	/** Strategy discriminant. */
	readonly kind: 'sliding-window';
	/** Fully resolved strategy storage key. */
	readonly key: string;
	/** Resolved Sliding Window configuration for this operation. */
	readonly options: SlidingWindowConsumeOptions;
}

/** Atomic Token Bucket operation used by `limitAllAtomic()`. */
export interface AtomicTokenBucketOperation {
	/** Strategy discriminant. */
	readonly kind: 'token-bucket';
	/** Fully resolved strategy storage key. */
	readonly key: string;
	/** Resolved Token Bucket configuration for this operation. */
	readonly options: TokenBucketConsumeOptions;
}

/** Atomic GCRA operation used by `limitAllAtomic()`. */
export interface AtomicGcraOperation {
	/** Strategy discriminant. */
	readonly kind: 'gcra';
	/** Fully resolved strategy storage key. */
	readonly key: string;
	/** Resolved GCRA configuration for this operation. */
	readonly options: GcraConsumeOptions;
}

/**
 * One strategy operation that can participate in an atomic limiter chain.
 *
 * Custom strategies may opt into `limitAllAtomic()` by returning one of these
 * descriptors from `toAtomicOperation()`. This intentionally limits atomic
 * composition to storage primitives with well-defined cross-backend semantics.
 */
export type AtomicLimitOperation =
	| AtomicFixedWindowOperation
	| AtomicSlidingWindowOperation
	| AtomicTokenBucketOperation
	| AtomicGcraOperation;

/** One active layer supplied to an atomic storage transaction. */
export interface AtomicLimitLayerInput {
	/** Strategy operation to evaluate and commit if every layer allows. */
	readonly operation: AtomicLimitOperation;
	/** Optional active-penalty key checked before this layer's strategy. */
	readonly penaltyKey?: string;
}

/** Result returned by an atomic multi-layer limiter transaction. */
export type AtomicLimitConsumeResult =
	| {
		readonly outcome: 'allowed';
		/** Post-consumption strategy result for every active layer. */
		readonly results: readonly LimitResult[];
	}
	| {
		readonly outcome: 'penalty-hit';
		/** Zero-based index of the layer whose active penalty rejected the chain. */
		readonly index: number;
		/** Provisional results for earlier layers. No strategy state was committed. */
		readonly results: readonly LimitResult[];
	}
	| {
		readonly outcome: 'throttled';
		/** Zero-based index of the strategy that rejected the chain. */
		readonly index: number;
		/** Provisional results through the rejecting layer. No state was committed. */
		readonly results: readonly LimitResult[];
	};

/**
 * Optional storage capability required by `limitAllAtomic()`.
 *
 * The storage engine must evaluate all penalty checks and strategy operations as
 * one transaction and commit strategy state only when every active layer allows.
 * Returning `penalty-hit` or `throttled` must leave every strategy key unchanged.
 */
export interface IAtomicLimitStorage {
	/**
	 * Evaluates every layer as one transaction and commits only when all layers allow.
	 *
	 * @param layers Fully resolved strategy operations and optional penalty keys.
	 */
	consumeAtomicLimit(
		layers: readonly AtomicLimitLayerInput[],
	): Promise<AtomicLimitConsumeResult>;
}

/** Parameters used to preview one Fixed Window decision without consuming it. */
export interface FixedWindowPreviewOptions {
	/** Maximum requests allowed during one window. */
	limit: number;
	/** Window duration in milliseconds. */
	timeFrame: number;
}

/**
 * Optional non-consuming inspection capabilities for built-in strategies.
 *
 * These methods are deliberately optional so existing custom storage engines do
 * not gain new mandatory methods merely because limiter introspection exists.
 * Built-in `MemoryStore` and `RedisStore` implement every preview operation.
 */
export interface ILimiterInspectionStorage {
	/** Previews the next Fixed Window decision without incrementing the counter. */
	previewFixedWindow?(key: string, options: FixedWindowPreviewOptions): Promise<LimitResult>;

	/** Previews the next Sliding Window decision without consuming capacity. */
	previewSlidingWindow?(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult>;

	/** Previews the next Token Bucket decision without consuming or persisting refill state. */
	previewTokenBucket?(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult>;

	/** Previews the next GCRA decision without advancing the schedule. */
	previewGcra?(key: string, options: GcraConsumeOptions): Promise<GcraConsumeResult>;

	/**
	 * Returns the remaining lifetime of a penalty marker in milliseconds.
	 * Returns `undefined` when the marker does not exist or has expired.
	 */
	getPenaltyTtl?(key: string): Promise<number | undefined>;
}

/** Parameters used to atomically apply one escalating penalty. */
export interface PenaltyEscalationApplyOptions {
	/** Base penalty duration resolved for the throttled update, in milliseconds. */
	basePenaltyTime: number;
	/** Multiplier applied to the previous effective penalty for each later strike. */
	factor: number;
	/** Maximum escalated duration in milliseconds. Never shortens the base duration. */
	maxPenaltyTime: number;
	/** Inactivity period after which the strike counter expires, in milliseconds. */
	resetAfter: number;
}

/** Result of atomically applying an escalating penalty. */
export interface PenaltyEscalationResult {
	/** Strike count after the current throttled update. */
	strikes: number;
	/** Penalty duration that was persisted, in milliseconds. */
	penaltyTime: number;
	/** Remaining strike-reset period, in milliseconds. */
	reset: number;
}

/** Non-consuming snapshot of persisted penalty strike state. */
export interface PenaltyStrikeState {
	/** Current strike count. */
	strikes: number;
	/** Effective duration applied by the most recent strike, in milliseconds. */
	lastPenaltyTime: number;
	/** Milliseconds until the strike counter expires. */
	reset: number;
}

/** Storage capability used by the optional penalty-box feature. */
export interface IPenaltyStorage {
	/** Stores an active penalty marker for `ttl` milliseconds. */
	setPenalty(key: string, ttl: number): Promise<void>;

	/** Returns whether a penalty marker is currently active. */
	checkPenalty(key: string): Promise<boolean>;
}

/**
 * Optional storage capability for atomic strike-based penalty escalation.
 *
 * Custom stores only need this capability when a rule enables penalty
 * escalation. The built-in `MemoryStore` and `RedisStore` implement it.
 */
export interface IPenaltyEscalationStorage {
	/** Atomically increments strike state and persists the resulting escalated penalty. */
	applyEscalatingPenalty(
		penaltyKey: string,
		strikeKey: string,
		options: PenaltyEscalationApplyOptions,
	): Promise<PenaltyEscalationResult>;

	/**
	 * Returns current strike state without mutating it.
	 *
	 * This method is optional because enforcement only requires
	 * `applyEscalatingPenalty()`. When omitted, limiter inspection reports strike
	 * state as unsupported while escalation itself continues to work.
	 */
	getPenaltyStrikeState?(strikeKey: string): Promise<PenaltyStrikeState | undefined>;
}

/**
 * Complete storage contract used by the built-in limiter features.
 *
 * The contract is intentionally expressed as named capabilities. This keeps the
 * atomicity requirements of each strategy explicit and gives future strategies a
 * clean place to add their own backend primitive without obscuring existing
 * semantics.
 *
 * Storage engines may be shared by multiple rules. Implementations must preserve
 * the documented atomicity guarantee of every capability they implement.
 */
export type IStorageEngine =
	& IStateStorage
	& IFixedWindowStorage
	& ISlidingWindowStorage
	& ITokenBucketStorage
	& IGcraStorage
	& IPenaltyStorage
	& ILimiterInspectionStorage
	& Partial<IPenaltyEscalationStorage>
	& Partial<IAtomicLimitStorage>
	& Partial<ILimiterRefundStorage>;

// ==================== Storage Failure Policy ====================

/** Individual storage operation that can fail while evaluating a limiter rule. */
export type StorageOperation =
	| 'get'
	| 'set'
	| 'delete'
	| 'increment'
	| 'consumeSlidingWindow'
	| 'consumeTokenBucket'
	| 'consumeGcra'
	| 'setPenalty'
	| 'checkPenalty'
	| 'applyEscalatingPenalty'
	| 'consumeAtomicLimit';

/** Middleware phase in which a storage failure became observable. */
export type StorageFailurePhase =
	| 'penalty-check'
	| 'strategy-check'
	| 'penalty-write'
	| 'composite-check';

/**
 * Built-in behavior when limiter-owned storage access fails.
 *
 * - `throw` preserves the storage error and rejects the middleware call.
 * - `fail-open` prioritizes availability and avoids blocking traffic because the
 *   limiter backend is unavailable.
 * - `fail-closed` prioritizes protection and does not allow traffic when the
 *   limiter cannot safely determine whether it should pass.
 *
 * If penalty persistence fails after an update has already been throttled, both
 * non-throwing modes preserve that rejection and skip the failed penalty write;
 * there is no safe way to retroactively reinterpret the completed decision.
 */
export type StorageFailureMode = 'throw' | 'fail-open' | 'fail-closed';

/** Metadata describing one failed limiter-owned storage operation. */
export interface StorageFailureInfo {
	/** Middleware phase that was in progress. */
	readonly phase: StorageFailurePhase;
	/** Storage method that failed. */
	readonly operation: StorageOperation;
	/** Exact storage key supplied to the failed method. */
	readonly key: string;
	/** Entity-specific key generated by `limitFor()`. */
	readonly entityKey: string;
	/** Original value thrown by the storage engine. */
	readonly error: unknown;
}

/**
 * Resolves how one storage failure should be handled.
 *
 * Resolvers may inspect the grammY context and failure metadata and may perform
 * asynchronous work. They must return one of the documented storage-failure
 * modes. Throwing from the resolver propagates normally.
 */
export type StorageFailurePolicyResolver<C extends GrammyContext> = (
	ctx: C,
	info: StorageFailureInfo,
) => StorageFailureMode | Promise<StorageFailureMode>;

/** Static storage-failure mode or context-aware resolver. */
export type StorageFailurePolicy<C extends GrammyContext> =
	| StorageFailureMode
	| StorageFailurePolicyResolver<C>;

// ==================== Strategy Contract ====================

/** Stable strategy labels used by diagnostics and developer tooling. */
export type LimiterStrategyKind =
	| 'fixed-window'
	| 'sliding-window'
	| 'token-bucket'
	| 'gcra'
	| 'cooldown'
	| 'custom';

/**
 * Defines a rate-limiting algorithm.
 *
 * Custom strategies receive a storage view with the same public capabilities as
 * the configured engine and may use its generic state operations or atomic
 * primitives as appropriate. The middleware may wrap this object internally to
 * classify storage failures, so custom strategies must not rely on storage object
 * identity.
 */
export interface ILimiterStrategy {
	/** Optional immutable configuration exposed for inspection. */
	readonly options?: Record<string, unknown>;

	/**
	 * Evaluates one matching update.
	 *
	 * @param key The unique storage key for the entity being limited.
	 * @param storage The storage engine configured for the rule.
	 * @returns Information describing whether the update is allowed and when capacity returns.
	 */
	check(key: string, storage: IStorageEngine): Promise<LimitResult>;

	/**
	 * Optionally previews the result of `check()` without consuming capacity.
	 *
	 * Custom strategies may omit this method. `LimiterMiddleware.inspect()` then
	 * reports strategy inspection as unsupported rather than mutating state to
	 * approximate an answer.
	 */
	preview?(key: string, storage: IStorageEngine): Promise<LimitResult | undefined>;

	/**
	 * Optionally clears all strategy-owned state rooted at `key`.
	 *
	 * Built-in strategies implement this capability. Custom strategies should
	 * implement it when `LimiterMiddleware.reset()` can safely remove every state
	 * record they own for the supplied key.
	 */
	reset?(key: string, storage: IStorageEngine): Promise<void>;

	/**
	 * Optionally restores one successful manual consumption for `key`.
	 *
	 * Returning `false` reports that the configured storage/strategy combination
	 * cannot refund safely or that the original capacity no longer contributes to
	 * active limiter state. Built-in strategies use the exact `result` object from
	 * the successful `check()` call to guard receipt-sensitive refunds.
	 *
	 * @param key Storage key used by the successful check.
	 * @param storage Storage engine configured for the rule.
	 * @param result Exact result object returned by the successful check.
	 */
	refund?(key: string, storage: IStorageEngine, result: LimitResult): Promise<boolean>;

	/**
	 * @internal Records a consumption result produced by a folded penalty-and-strategy
	 * storage round trip instead of by {@link ILimiterStrategy.check}.
	 *
	 * The limiter runtime may evaluate an active-penalty check together with this
	 * strategy in one storage operation. Strategies that keep per-consumption state
	 * for receipt-sensitive refunds implement this so that path stays identical to a
	 * normal `check()` call.
	 */
	adoptConsumption?(result: LimitResult): void;

	/**
	 * Optionally describes this strategy as one built-in atomic storage primitive.
	 *
	 * Strategies that omit this method continue to work with `limit()` and
	 * `limitAll()`, but cannot participate in `limitAllAtomic()`. Custom strategies
	 * should only implement this when the returned descriptor is semantically
	 * equivalent to their normal `check()` behavior.
	 */
	toAtomicOperation?(key: string): AtomicLimitOperation;
}

// ==================== Results & State ====================

/** Result returned by every limiter strategy. */
export interface LimitResult {
	/** Whether the current update may continue to downstream middleware. */
	isAllowed: boolean;

	/**
	 * Whole requests that can still pass immediately after this check.
	 *
	 * This value is never negative. Fixed Window returns the remaining request
	 * count in the active window. Token Bucket and GCRA report the number of
	 * additional whole requests that fit at the current request cost.
	 */
	remaining: number;

	/**
	 * Strategy-specific reset delay in milliseconds.
	 *
	 * For Fixed Window this is the remaining lifetime of the active window. For
	 * Token Bucket and GCRA this is the time until another request at the current
	 * request cost can pass, and is `0` when one can already pass.
	 */
	reset: number;
}

/** Persisted state used by the built-in Token Bucket implementation. */
export interface TokenBucketState {
	/** Current token balance, which may be fractional. */
	tokens: number;
	/** Millisecond timestamp at which the bucket was last refilled. */
	lastRefill: number;
}

/** Custom identity fields attached to opt-in rich limiter metadata. */
export type LimiterMetadataFields = Readonly<Record<string, unknown>>;

/**
 * Identity metadata attached to structured decisions when `Limiter.withMetadata()`
 * is enabled. Only stable numeric Telegram identifiers are captured automatically.
 * Names, usernames, message contents, and other profile data are never collected.
 *
 * Custom fields are nested under `custom` so application metadata cannot shadow
 * built-in identity fields. The resolver return type is preserved by TypeScript.
 */
export interface LimiterMetadata<M extends LimiterMetadataFields = LimiterMetadataFields> {
	/** Telegram user identifier from `ctx.from.id`, when present. */
	readonly userId?: number;
	/** Telegram chat identifier from `ctx.chat.id`, when present. */
	readonly chatId?: number;
	/** Application-defined identity fields supplied by `withMetadata(resolver)`. */
	readonly custom?: Readonly<M>;
}

/** Synchronous custom metadata resolver used by `Limiter.withMetadata(resolver)`. */
export type LimiterMetadataResolver<
	C extends GrammyContext,
	M extends LimiterMetadataFields,
> = (ctx: C) => M;

/** @internal Metadata-selection helper used to preserve opt-in metadata inference. */
type LimiterMetadataSelection = LimiterMetadataFields | undefined;

/** @internal Conditionally attaches metadata to public structured results. */
type LimiterMetadataProperty<M extends LimiterMetadataSelection> = M extends undefined
	? { readonly metadata?: never }
	: { readonly metadata: LimiterMetadata<Extract<M, LimiterMetadataFields>> };

/** Strike information returned for an escalating penalty. */
export type LimiterPenaltyEscalationInspection =
	| {
		readonly configured: false;
	}
	| {
		readonly configured: true;
		readonly supported: false;
		readonly key: string;
	}
	| {
		readonly configured: true;
		readonly supported: true;
		readonly key: string;
		readonly strikes: number;
		/** Effective duration applied by the latest strike, when strike state exists. */
		readonly lastPenaltyTime: number | undefined;
		/** Milliseconds until strikes reset, or `undefined` when no strike state exists. */
		readonly resetsIn: number | undefined;
	};

/** Penalty information returned by limiter introspection. */
export type LimiterPenaltyInspection =
	| {
		readonly configured: false;
	}
	| {
		readonly configured: true;
		readonly key: string;
		readonly active: boolean;
		/** Remaining penalty lifetime when the storage backend exposes it. */
		readonly expiresIn: number | undefined;
		/** Strike/escalation state for this penalty configuration. */
		readonly escalation: LimiterPenaltyEscalationInspection;
	};

/** Result of previewing a strategy without consuming capacity. */
export type LimiterStrategyInspection =
	| {
		readonly supported: true;
		readonly result: LimitResult;
	}
	| {
		readonly supported: false;
	};

/**
 * @internal Base shape used by `LimiterInspection`.
 *
 * Non-consuming snapshot returned by `LimiterMiddleware.inspect()`.
 *
 * `outcome: 'bypassed'` mirrors middleware applicability for `onlyIf()` and
 * missing entity keys. `outcome: 'ready'` exposes the exact runtime namespaces,
 * penalty state, and—when supported—a preview of what the configured strategy
 * would return for the next request without mutating limiter state.
 */
type LimiterInspectionBase =
	| {
		readonly outcome: 'bypassed';
		/** Optional human-readable name assigned with `Limiter.withName()`. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly reason: 'filter' | 'missing-key';
	}
	| {
		readonly outcome: 'ready';
		/** Optional human-readable name assigned with `Limiter.withName()`. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly entityKey: string;
		readonly storageKey: string;
		readonly penalty: LimiterPenaltyInspection;
		readonly strategy: LimiterStrategyInspection;
	};

/**
 * Non-consuming snapshot of one limiter rule for the current context.
 *
 * Metadata is present only when explicitly enabled with `Limiter.withMetadata()`.
 */
export type LimiterInspection<
	M extends LimiterMetadataSelection = undefined,
> = LimiterInspectionBase & LimiterMetadataProperty<M>;

/** Storage-failure policy description included in explicit diagnostics. */
export type LimiterStorageFailurePolicyDiagnostic =
	| {
		readonly kind: 'static';
		readonly mode: StorageFailureMode;
	}
	| {
		readonly kind: 'dynamic';
	};

/** Strategy snapshot included in explicit diagnostics. */
export type LimiterStrategyDiagnostic =
	| {
		readonly kind: LimiterStrategyKind;
		readonly options?: Readonly<Record<string, unknown>>;
		readonly previewSupported: true;
		readonly result: LimitResult;
	}
	| {
		readonly kind: LimiterStrategyKind;
		readonly options?: Readonly<Record<string, unknown>>;
		readonly previewSupported: false;
	};

/**
 * @internal Base shape used by `LimiterDiagnostic`.
 *
 * Explicit, non-consuming explanation of what one limiter rule would do now.
 *
 * `diagnose()` is intentionally pull-based rather than environment-controlled:
 * it performs work only when called. It never consumes capacity, persists a
 * penalty, invokes `onThrottled()`, or emits limiter events.
 */
type LimiterDiagnosticBase =
	| {
		readonly outcome: 'bypassed';
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly wouldContinue: true;
		readonly reason: 'filter' | 'missing-key';
		readonly storageFailurePolicy: LimiterStorageFailurePolicyDiagnostic;
	}
	| {
		readonly outcome: 'penalty-hit';
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly wouldContinue: boolean;
		readonly entityKey: string;
		readonly storageKey: string;
		readonly penalty: LimiterPenaltyInspection & { readonly configured: true };
		readonly strategyKind: LimiterStrategyKind;
		readonly storageFailurePolicy: LimiterStorageFailurePolicyDiagnostic;
	}
	| {
		readonly outcome: 'would-allow' | 'would-throttle';
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly wouldContinue: boolean;
		readonly entityKey: string;
		readonly storageKey: string;
		readonly penalty: LimiterPenaltyInspection;
		readonly strategy: LimiterStrategyDiagnostic & { readonly previewSupported: true };
		readonly storageFailurePolicy: LimiterStorageFailurePolicyDiagnostic;
	}
	| {
		readonly outcome: 'unknown';
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly wouldContinue: undefined;
		readonly reason: 'strategy-preview-unsupported';
		readonly entityKey: string;
		readonly storageKey: string;
		readonly penalty: LimiterPenaltyInspection;
		readonly strategy: LimiterStrategyDiagnostic & { readonly previewSupported: false };
		readonly storageFailurePolicy: LimiterStorageFailurePolicyDiagnostic;
	};

/**
 * Explicit, non-consuming diagnostic result for one limiter rule.
 *
 * Unlike normal evaluation, diagnostics never consume capacity or persist penalty state.
 */
export type LimiterDiagnostic<
	M extends LimiterMetadataSelection = undefined,
> = LimiterDiagnosticBase & LimiterMetadataProperty<M>;

/** Explicit diagnostic capability attached to the middleware returned by `limit()`. */
export interface LimiterDiagnostics<
	C extends GrammyContext,
	M extends LimiterMetadataSelection = undefined,
> {
	/**
	 * Explains the current rule outcome without consuming limiter capacity.
	 *
	 * The rule's predicate, key generator, enabled rich metadata, penalty state,
	 * and strategy preview are evaluated. No limiter events or application
	 * throttling callbacks are invoked. Custom strategies without `preview()`
	 * produce `outcome: 'unknown'` instead of being executed destructively.
	 *
	 * @param ctx Current grammY context.
	 */
	diagnose(ctx: C): Promise<LimiterDiagnostic<M>>;
}

/** One rule snapshot inside a composite diagnostic. */
export interface LimiterCompositeDiagnosticLayer {
	/** Zero-based layer position in the composite. */
	readonly index: number;
	/** Non-consuming diagnostic snapshot for this layer. */
	readonly diagnostic: LimiterDiagnostic<LimiterMetadataFields | undefined>;
}

/** Non-consuming explanation returned by `limitAll().diagnose()` and `limitAllAtomic().diagnose()`. */
export type LimiterCompositeDiagnostic =
	| {
		readonly mode: 'sequential' | 'atomic';
		readonly outcome: 'would-continue';
		readonly layers: readonly LimiterCompositeDiagnosticLayer[];
	}
	| {
		readonly mode: 'sequential' | 'atomic';
		readonly outcome: 'would-block';
		readonly blockingLayer: number;
		readonly layers: readonly LimiterCompositeDiagnosticLayer[];
	}
	| {
		readonly mode: 'sequential' | 'atomic';
		readonly outcome: 'unknown';
		readonly uncertainLayer: number;
		readonly layers: readonly LimiterCompositeDiagnosticLayer[];
	};

/** grammY middleware with an explicit non-consuming composite diagnostic API. */
export type LimiterCompositeMiddleware<C extends GrammyContext> =
	& GrammyMiddlewareFn<C>
	& {
		/**
		 * Previews the currently observable state of the composite without consuming capacity.
		 *
		 * Diagnostics are a snapshot, not a reservation. Sequential diagnostics stop at the
		 * first blocking or indeterminate layer. Atomic diagnostics inspect every layer so a
		 * known blocker can still be reported when another custom strategy is indeterminate.
		 */
		diagnose(ctx: C): Promise<LimiterCompositeDiagnostic>;
	};

/**
 * Result returned by `LimiterConsumer.consume()`.
 *
 * The structured limiter decision is returned directly and augmented with
 * `isAllowed`, which answers the practical control-flow question: would the
 * configured middleware continue downstream for this context? This means
 * observe-only throttles and fail-open storage failures return `true` even when
 * the underlying decision records a throttle or storage failure.
 */
export type LimiterConsumeResult<
	M extends LimiterMetadataSelection = undefined,
> = LimiterDecision<M> & {
	/** Whether callers should continue the protected operation. */
	readonly isAllowed: boolean;
};

/** Manual execution capability attached to the middleware returned by `limit()`. */
export interface LimiterConsumer<
	C extends GrammyContext,
	M extends LimiterMetadataSelection = undefined,
> {
	/**
	 * Evaluates and consumes one limiter decision without invoking grammY `next()`.
	 *
	 * This uses the same enforcement path as normal middleware: `onlyIf()`, key
	 * generation, active penalties, strategy consumption, storage-failure policy,
	 * observe-only behavior, events, `onThrottled()`, penalty persistence, and
	 * escalation are all preserved. Rich metadata is resolved when enabled because
	 * the decision is returned to the caller.
	 *
	 * @param ctx Current grammY context.
	 * @returns The structured decision plus whether the protected operation may continue.
	 */
	consume(ctx: C): Promise<LimiterConsumeResult<M>>;
}

/** Refund controls attached to the middleware returned by `limit()`. */
export interface LimiterRefunder<
	M extends LimiterMetadataSelection = undefined,
> {
	/**
	 * Restores capacity consumed by one successful `consume()` result.
	 *
	 * Refund receipts are internal, single-use, and bound to the limiter instance
	 * that produced the result. Results that were bypassed, throttled, already
	 * refunded, or produced by another limiter return `false`. Penalty and strike
	 * state are never modified. A failed refund remains retryable.
	 *
	 * @param result Exact object returned by this limiter's `consume()` method.
	 * @returns `true` after capacity is restored, otherwise `false`.
	 */
	refund(result: LimiterConsumeResult<M>): Promise<boolean>;

	/**
	 * Schedules the same single-use refund without awaiting storage I/O.
	 *
	 * Returns immediately. Storage/refund failures are contained so this method
	 * cannot create an unhandled promise rejection; failures are reported through
	 * the `refundError` event. Completion is not guaranteed if the process exits
	 * before the detached operation finishes.
	 *
	 * @param result Exact object returned by this limiter's `consume()` method.
	 * @returns `true` when a refundable receipt was scheduled or already in flight.
	 */
	refundBestEffort(result: LimiterConsumeResult<M>): boolean;
}

/** Administrative controls attached to the middleware returned by `limit()`. */
export interface LimiterControls<
	C extends GrammyContext,
	M extends LimiterMetadataSelection = undefined,
> {
	/**
	 * Inspects the current rule for `ctx` without consuming strategy capacity.
	 *
	 * The rule's `onlyIf()` predicate is evaluated so bypass behavior matches the
	 * middleware. Storage failures from this administrative operation propagate
	 * directly and are not interpreted through the middleware failure policy.
	 */
	inspect(ctx: C): Promise<LimiterInspection<M>>;

	/**
	 * Deletes strategy state for the entity resolved from `ctx`.
	 *
	 * This operation intentionally ignores `onlyIf()` so an administrator can
	 * reset state even when the current context would bypass the middleware. It
	 * does not clear an active penalty. Returns `false` when no entity key can be
	 * resolved or the custom strategy does not expose reset support, otherwise
	 * `true` after the strategy reset completes.
	 */
	reset(ctx: C): Promise<boolean>;

	/**
	 * Deletes penalty state for the entity resolved from `ctx`.
	 *
	 * This operation intentionally ignores `onlyIf()` and leaves strategy state
	 * untouched. Returns `false` when the rule has no penalty configuration or no
	 * entity key can be resolved.
	 */
	clearPenalty(ctx: C): Promise<boolean>;

	/**
	 * Deletes escalation strike state for the entity resolved from `ctx`.
	 *
	 * This is intentionally separate from `clearPenalty()` so administrators can
	 * unmute an entity without forgiving its recent strike history, or vice versa.
	 * Returns `false` when escalation is not configured or no entity key resolves.
	 */
	clearStrikes(ctx: C): Promise<boolean>;
}

/**
 * grammY middleware returned by `limit()`, augmented with manual and state controls.
 *
 * It remains directly assignable to grammY's `MiddlewareFn<C>` and can be passed
 * to `bot.use()` without adapters.
 */
export type LimiterMiddleware<
	C extends GrammyContext,
	M extends LimiterMetadataSelection = undefined,
> =
	& GrammyMiddlewareFn<C>
	& LimiterConsumer<C, M>
	& LimiterRefunder<M>
	& LimiterControls<C, M>
	& LimiterDiagnostics<C, M>;

// ==================== Observability ====================

/** Reason an update bypassed normal limiter evaluation. */
export type LimiterBypassReason = 'filter' | 'missing-key' | 'storage-failure';

/** Metadata emitted when an update bypasses normal limiter evaluation. */
export interface LimiterBypassInfo {
	/** Why the update bypassed normal limiting. */
	readonly reason: LimiterBypassReason;
	/** Entity key when one had already been generated. */
	readonly entityKey?: string;
	/** Failed storage phase when `reason` is `storage-failure`. */
	readonly phase?: StorageFailurePhase;
}

/** Runtime behavior of a limiter rule. */
export type LimiterMode = 'enforce' | 'observe';

/**
 * @internal Base shape used by `LimiterDecision`.
 *
 * Structured limiter decision metadata emitted for observability.
 *
 * The discriminated `outcome` field is intended for logs, metrics, and traces.
 * Existing fine-grained events remain available for backwards-compatible
 * instrumentation, while `decision` provides one stable, typed event for new
 * integrations.
 */
type LimiterDecisionBase =
	| {
		readonly outcome: 'bypassed';
		/** Optional human-readable name of the rule that produced this decision. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly reason: LimiterBypassReason;
		readonly entityKey?: string;
		readonly phase?: StorageFailurePhase;
	}
	| {
		readonly outcome: 'allowed' | 'throttled';
		/** Optional human-readable name of the rule that produced this decision. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly entityKey: string;
		readonly storageKey: string;
		readonly result: LimitResult;
	}
	| {
		readonly outcome: 'penalty-hit';
		/** Optional human-readable name of the rule that produced this decision. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly entityKey: string;
		readonly penaltyKey: string;
	}
	| {
		readonly outcome: 'storage-failure';
		/** Optional human-readable name of the rule that produced this decision. */
		readonly ruleName?: string;
		readonly mode: LimiterMode;
		readonly entityKey: string;
		readonly phase: StorageFailurePhase;
		readonly operation: StorageOperation;
		readonly key: string;
		readonly resolution: Exclude<StorageFailureMode, 'throw'>;
		readonly error: unknown;
	};

/**
 * Structured outcome emitted by limiter evaluation for observability and manual use.
 *
 * Metadata is included only when explicitly enabled on the rule.
 */
export type LimiterDecision<
	M extends LimiterMetadataSelection = undefined,
> = LimiterDecisionBase & LimiterMetadataProperty<M>;

/** Execution path that produced one structured limiter metric. */
export type LimiterMetricSource =
	| 'middleware'
	| 'manual-consume'
	| 'atomic-composite'
	| 'refund'
	| 'refund-best-effort';

/** Metric emitted for one completed limiter decision. */
export interface LimiterDecisionMetric<
	M extends LimiterMetadataSelection = undefined,
> {
	/** Discriminant for decision metrics. */
	readonly kind: 'decision';
	/** Runtime path that evaluated the limiter decision. */
	readonly source: 'middleware' | 'manual-consume' | 'atomic-composite';
	/** Wall-clock timestamp, in Unix milliseconds, when the metric was emitted. */
	readonly timestamp: number;
	/** Monotonic elapsed time spent resolving the decision, in milliseconds. */
	readonly durationMs: number;
	/** Structured decision, including optional rule name and enabled rich metadata. */
	readonly decision: LimiterDecision<M>;
}

/** Metric emitted for one receipt-backed manual refund attempt. */
export interface LimiterRefundMetric<
	M extends LimiterMetadataSelection = undefined,
> {
	/** Discriminant for refund metrics. */
	readonly kind: 'refund';
	/** Whether the caller awaited the refund or scheduled best-effort detached work. */
	readonly source: 'refund' | 'refund-best-effort';
	/** Wall-clock timestamp, in Unix milliseconds, when the metric was emitted. */
	readonly timestamp: number;
	/** Monotonic elapsed time spent attempting the refund, in milliseconds. */
	readonly durationMs: number;
	/** Final result of the refund operation. */
	readonly outcome: 'succeeded' | 'unsupported' | 'failed';
	/** Original successful manual-consume result whose capacity was being restored. */
	readonly result: LimiterConsumeResult<M>;
	/** Original failure value when `outcome` is `failed`. */
	readonly error?: unknown;
}

/**
 * Vendor-neutral structured metric emitted by the optional `metric` event.
 *
 * No metric object, wall-clock timestamp, or duration measurement is created
 * unless the built rule has at least one `metric` listener. This keeps the
 * default limiter hot path unchanged. Rich identity remains independently
 * opt-in through `Limiter.withMetadata()` and is carried by the nested decision
 * or consume result when enabled.
 */
export type LimiterMetric<
	M extends LimiterMetadataSelection = undefined,
> = LimiterDecisionMetric<M> | LimiterRefundMetric<M>;

/**
 * Events emitted by a limiter rule.
 *
 * Event names are intentionally a closed set so editors can autocomplete them
 * and TypeScript can reject typos. Event listeners run synchronously. If a
 * listener throws, the exception propagates through the middleware call.
 */
export interface LimiterEvents<
	C extends GrammyContext,
	M extends LimiterMetadataSelection = undefined,
> {
	/** Fired after a strategy allows an update and before downstream middleware runs. */
	allowed: [ctx: C, info: LimitResult];

	/** Fired after a strategy rejects an update. */
	throttled: [ctx: C, info: LimitResult];

	/** Fired when normal limiter evaluation is bypassed and downstream middleware may continue. */
	bypassed: [ctx: C, info: LimiterBypassInfo];

	/** Fired when an already-active penalty prevents strategy evaluation. */
	penaltyHit: [ctx: C, entityKey: string];

	/** Fired after an enforcement penalty marker has been successfully persisted. */
	penaltyApplied: [ctx: C, entityKey: string, duration: number];

	/**
	 * Fired after an enforcement strike is persisted for an escalating penalty.
	 * The first penalty is strike `1`; `duration` is the effective persisted duration.
	 */
	penaltyStrike: [ctx: C, entityKey: string, strikes: number, duration: number];

	/** Fired whenever limiter-owned storage access fails, before failure policy resolution. */
	storageError: [ctx: C, info: StorageFailureInfo];

	/**
	 * Fired when a detached `refundBestEffort()` operation fails.
	 *
	 * The consume result retains enabled rich metadata, including Telegram identity,
	 * so applications can correlate the failure without re-running metadata logic.
	 */
	refundError: [ctx: C, result: LimiterConsumeResult<M>, error: unknown];

	/**
	 * Fired for vendor-neutral decision/refund metrics when explicitly observed.
	 *
	 * Metric generation is lazy: when no listener is registered, the limiter does
	 * not capture timers, timestamps, or metadata for metrics. Listener exceptions
	 * follow the same synchronous propagation semantics as every other limiter event.
	 */
	metric: [ctx: C, metric: LimiterMetric<M>];

	/**
	 * Fired whenever the limiter resolves a structured decision point.
	 *
	 * Prefer this event for structured telemetry, especially in observe-only mode,
	 * where it distinguishes decisions that were measured from decisions that were
	 * actually enforced.
	 */
	decision: [ctx: C, decision: LimiterDecision<M>];
}

// ==================== Configuration & Helpers ====================

/**
 * Callback invoked when an update is throttled.
 *
 * The middleware awaits returned promises before applying an optional penalty,
 * so asynchronous notification/logging handlers may be used safely. This
 * callback is enforcement-only and is skipped by `observeOnly()` rules.
 *
 * Storage operations performed manually inside this callback are application
 * code and are not governed by the limiter's storage-failure policy.
 */
export type OnLimitExceeded<C extends GrammyContext> = (
	ctx: C,
	info: LimitResult,
	storage: IStorageEngine,
) => void | Promise<void>;

/**
 * Generates the entity-specific portion of a storage key.
 * Returning `undefined` bypasses the limiter for the current update.
 */
export type KeyGenerator<C extends GrammyContext> = (ctx: C) => string | undefined;

/** Generates a Sliding Window limit or request cost from the current grammY context. */
export type SlidingWindowOptionGenerator<C extends GrammyContext> = (ctx: C) => number;

/** Generates the cost of the current request for a Sliding Window rule. */
export type SlidingWindowCostGenerator<C extends GrammyContext> = (ctx: C) => number;

/**
 * Context-aware configuration accepted by `Limiter.slidingWindow()`.
 *
 * `limit` and `cost` may be generated from the current context. `timeFrame` is
 * intentionally static: changing bucket geometry for the same persisted key
 * between updates would make rolling-window state ambiguous.
 */
export interface SlidingWindowOptions<C extends GrammyContext> {
	/** Maximum cost units admitted during the rolling window. */
	readonly limit: number | SlidingWindowOptionGenerator<C>;
	/** Rolling-window duration in milliseconds. Must be a positive integer. */
	readonly timeFrame: number;
	/**
	 * Cost units consumed by one matching update.
	 *
	 * Defaults to `1`. The resolved value must be finite, positive, and no greater
	 * than the resolved `limit`.
	 */
	readonly cost?: number | SlidingWindowCostGenerator<C>;
}

/** Generates one numeric Token Bucket option from the current grammY context. */
export type TokenBucketOptionGenerator<C extends GrammyContext> = (ctx: C) => number;

/** Generates the token cost of the current request. */
export type TokenCostGenerator<C extends GrammyContext> = (ctx: C) => number;

/**
 * Context-aware Token Bucket configuration accepted by `Limiter.tokenBucket()`.
 *
 * Every numeric option may be static or generated from the current grammY
 * context. Dynamic values are resolved and validated independently for each
 * matching update.
 */
export interface TokenBucketOptions<C extends GrammyContext> {
	/** Maximum tokens the bucket can hold, controlling burst capacity. */
	readonly bucketSize: number | TokenBucketOptionGenerator<C>;
	/** Number of tokens replenished per `interval`. */
	readonly tokensPerInterval: number | TokenBucketOptionGenerator<C>;
	/** Refill interval in milliseconds. */
	readonly interval: number | TokenBucketOptionGenerator<C>;
	/**
	 * Tokens consumed by one matching update.
	 *
	 * Defaults to `1`. The resolved cost must be finite, positive, and no greater
	 * than the resolved `bucketSize`.
	 */
	readonly cost?: number | TokenCostGenerator<C>;
}

/**
 * Resolves a cooldown duration in milliseconds for the current grammY context.
 *
 * The resolved value must be a positive integer. `Limiter.cooldown()` uses this
 * duration as the minimum interval between two allowed matching actions.
 */
export type CooldownDurationGenerator<C extends GrammyContext> = (ctx: C) => number;

/** Generates one numeric GCRA option from the current grammY context. */
export type GcraOptionGenerator<C extends GrammyContext> = (ctx: C) => number;

/** Generates the GCRA cost of the current request. */
export type GcraCostGenerator<C extends GrammyContext> = (ctx: C) => number;

/**
 * Context-aware GCRA configuration accepted by `Limiter.gcra()`.
 *
 * `rate` is sustained capacity in cost units per `interval`. `burst` is the
 * maximum cost capacity available immediately after a fully idle period. Every
 * numeric option may be static or generated from the current grammY context.
 */
export interface GcraOptions<C extends GrammyContext> {
	/** Sustained number of cost units admitted per `interval`. */
	readonly rate: number | GcraOptionGenerator<C>;
	/** Rate interval in milliseconds. */
	readonly interval: number | GcraOptionGenerator<C>;
	/** Maximum cost units admitted immediately after the key is fully idle. */
	readonly burst: number | GcraOptionGenerator<C>;
	/**
	 * Cost units consumed by one matching update.
	 *
	 * Defaults to `1`. The resolved value must be finite, positive, and no greater
	 * than the resolved `burst`.
	 */
	readonly cost?: number | GcraCostGenerator<C>;
}

/** Generates a positive-integer Fixed Window request limit for the current context. */
export type DynamicLimitGenerator<C extends GrammyContext> = (ctx: C) => number;

/**
 * Generates a penalty duration in milliseconds for a throttled update.
 * Returning `0` or a negative value skips penalty creation for that update.
 * Positive fractional durations are rounded up to the next whole millisecond.
 */
export type PenaltyDurationGenerator<C extends GrammyContext> = (
	ctx: C,
	info: LimitResult,
) => number;

/** Configuration for strike-based geometric penalty escalation. */
export interface PenaltyEscalationOptions {
	/**
	 * Multiplier applied to the previous effective penalty for each later strike.
	 * Defaults to `2`; must be finite and greater than `1`.
	 */
	readonly factor?: number;
	/**
	 * Maximum escalated duration in milliseconds. A dynamic base duration larger
	 * than this value is never shortened. Positive fractional values are rounded up.
	 */
	readonly maxPenaltyTime: number;
	/**
	 * Inactivity period after which strike history expires. Must be a positive
	 * integer number of milliseconds. Active penalty hits do not refresh this timer.
	 */
	readonly resetAfter: number;
}

/** Options accepted by `Limiter.withPenalty()`. */
export interface PenaltyOptions<C extends GrammyContext> {
	/** Fixed or context-dependent base penalty duration in milliseconds. */
	readonly penaltyTime: number | PenaltyDurationGenerator<C>;
	/**
	 * Optional custom penalty namespace. Defaults to `<keyPrefix>:PENALTY`. When
	 * escalation is enabled, its strike namespace is derived from this prefix too.
	 */
	readonly penaltyKeyPrefix?: string;
	/** Optional strike-based escalation configuration. */
	readonly escalation?: PenaltyEscalationOptions;
}
