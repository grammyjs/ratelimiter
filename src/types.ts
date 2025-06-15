/**
 * A minimal, structurally-compatible representation of the grammY Context object.
 */
export interface GrammyContext {
	from?: {
		id: number;
		is_bot: boolean;
		first_name: string;
		last_name?: string;
		username?: string;
		language_code?: string;
	};
	chat?: {
		id: number;
		type: 'private' | 'group' | 'supergroup' | 'channel';
		title?: string;
		username?: string;
		first_name?: string;
	};
}

export type NextFunction = () => Promise<void>;

// ==================== Core Interfaces ====================

/**
 * Defines the contract for a storage engine.
 */
export interface IStorageEngine {
	/**
	 * Retrieves the state for a given key.
	 *
	 * @param key The unique identifier for the entity being limited.
	 * @returns A promise that resolves to the state, or undefined if not found.
	 */
	get(key: string): Promise<TokenBucketState | undefined>;

	/**
	 * Sets the state for a given key.
	 *
	 * @param key The unique identifier.
	 * @param state The new state to store.
	 * @param ttl The Time To Live for the record, in milliseconds.
	 */
	set(key: string, state: TokenBucketState, ttl: number): Promise<void>;

	/**
	 * Deletes the state for a given key.
	 *
	 * @param key The unique identifier.
	 */
	delete(key: string): Promise<void>;

	/**
	 * Atomically increments a key and sets its expiry on the first increment.
	 *
	 * @param key The unique identifier.
	 * @param ttl The Time To Live for the record, in milliseconds.
	 * @returns The new value of the counter.
	 */
	increment(key: string, ttl: number): Promise<number>;

	/**
	 * Sets a key with a simple "true" value.
	 *
	 * @param key The unique identifier for the penalty.
	 * @param ttl The duration of the penalty in milliseconds.
	 */
	setPenalty(key: string, ttl: number): Promise<void>;

	/**
	 * Checks for the existence of a penalty key.
	 *
	 * @param key The unique identifier for the penalty.
	 * @returns A promise that resolves to true if the penalty exists.
	 */
	checkPenalty(key: string): Promise<boolean>;
}

/**
 * Defines the contract for a rate-limiting algorithm (Strategy).
 */
export interface ILimiterStrategy<T> {
	/**
	 * The configuration options used to create this strategy instance.
	 */
	readonly options?: Record<string, unknown>;

	/**
	 * Called on every incoming request that matches the rule.
	 *
	 * @param key The unique identifier for the entity being limited.
	 * @param storage The storage engine used to persist state.
	 * @returns A promise that resolves to a `LimitResult`.
	 */
	check(key: string, storage: IStorageEngine): Promise<LimitResult>;
}

// ==================== Result & State Types ====================

/**
 * The rich result object returned by a limiter strategy.
 */
export interface LimitResult {
	isAllowed: boolean;
	remaining: number;
	reset: number;
}

/** The data structure used by the Token Bucket strategy. */
export interface TokenBucketState {
	tokens: number;
	lastRefill: number;
}

/** The data structure used by the Fixed Window strategy. */
export interface FixedWindowState {
	hits: number;
}

// ==================== Configuration & Helper Types ====================

/** A map of event names to their corresponding listener argument types. */
// deno-lint-ignore no-explicit-any
export type EventMap = Record<string, any[]>;

/**
 * Describes the events that can be emitted by the limiter, mapping
 * event names to the arguments their listeners will receive.
 */
export interface LimiterEvents<C extends GrammyContext> extends EventMap {
	/**
	 * Fired when a request is allowed to pass.
	 */
	allowed: [ctx: C, info: LimitResult];

	/**
	 * Fired when a request is throttled (rate-limited).
	 */
	throttled: [ctx: C, info: LimitResult];

	/**
	 * Fired when a penalty is applied to a key.
	 */
	penaltyApplied: [ctx: C, key: string, duration: number];
}

/**
 * A function executed when a user is being rate-limited.
 *
 * @param ctx The grammY context object.
 * @param info Information about the limit that was hit.
 * @param storage The storage engine instance, for advanced use cases like notification locks.
 */
export type OnLimitExceeded<C extends GrammyContext> = (ctx: C, info: LimitResult, storage: IStorageEngine) => unknown;

export type KeyGenerator<C extends GrammyContext> = (ctx: C) => string | undefined;
export type DynamicLimitGenerator<C extends GrammyContext> = (ctx: C) => number;
export type PenaltyDurationGenerator<C extends GrammyContext> = (ctx: C, info: LimitResult) => number;

export type Mutable<T> = {
	-readonly [P in keyof T]: T[P];
};
