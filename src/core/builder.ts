import { Rule } from './rule.ts';
import { GcraStrategy } from '../strategies/gcra.ts';
import { EventEmitter } from '../lib/event_emitter.ts';
import { FixedWindowStrategy } from '../strategies/fixed_window.ts';
import { TokenBucketStrategy } from '../strategies/token_bucket.ts';
import { SlidingWindowStrategy } from '../strategies/sliding_window.ts';

import type {
	CooldownDurationGenerator,
	DynamicLimitGenerator,
	GcraOptions,
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimiterEvents,
	LimiterMetadataFields,
	LimiterMetadataResolver,
	LimitResult,
	OnLimitExceeded,
	PenaltyDurationGenerator,
	PenaltyOptions,
	SlidingWindowOptions,
	StorageFailurePolicy,
	TokenBucketOptions,
} from '../types.ts';

import {
	GLOBAL_SCOPE_KEY,
	type PenaltyEscalationDraft,
	type RuleDraft,
	type StrategyResetter,
} from './configuration.ts';

function resolveNumericOption<C extends GrammyContext>(
	value: number | ((ctx: C) => number),
	ctx: C,
): number {
	return typeof value === 'function' ? value(ctx) : value;
}

const resetSingleKeyStrategy: StrategyResetter = async (key, storage) => {
	await storage.delete(key);
};

/**
 * Fluent builder for constructing a validated rate-limiter rule.
 *
 * A builder may be passed directly to `limit()`, which builds it once when the
 * middleware is created, or finalized explicitly with `build()`.
 */
export class Limiter<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
> {
	/**
	 * Creates a limiter preconfigured to rate-limit each Telegram user independently.
	 *
	 * This is pure builder shorthand for `new Limiter<C>().limitFor('user')`.
	 * No strategy, storage, key prefix, penalty, or other behavior is selected.
	 * Updates without `ctx.from` bypass the rule exactly as with `limitFor('user')`.
	 *
	 * @returns A new limiter builder scoped by `ctx.from.id`.
	 */
	public static perUser<C extends GrammyContext = GrammyContext>(): Limiter<C> {
		return new Limiter<C>().limitFor('user');
	}

	/**
	 * Creates a limiter preconfigured to rate-limit each Telegram chat independently.
	 *
	 * This is pure builder shorthand for `new Limiter<C>().limitFor('chat')`.
	 * Updates without `ctx.chat` bypass the rule exactly as with `limitFor('chat')`.
	 *
	 * @returns A new limiter builder scoped by `ctx.chat.id`.
	 */
	public static perChat<C extends GrammyContext = GrammyContext>(): Limiter<C> {
		return new Limiter<C>().limitFor('chat');
	}

	/**
	 * Creates a limiter scoped to the `(user, chat)` pair for each update.
	 *
	 * This is useful when the same user should receive independent capacity in
	 * different chats. The generated entity key is `<userId>:<chatId>`. Updates
	 * missing either `ctx.from` or `ctx.chat` bypass the rule.
	 *
	 * This helper only configures key generation; all strategy, storage, penalty,
	 * metadata, and observability choices remain explicit on the returned builder.
	 *
	 * @returns A new limiter builder scoped by both Telegram user and chat IDs.
	 */
	public static perUserPerChat<C extends GrammyContext = GrammyContext>(): Limiter<C> {
		return new Limiter<C>().limitFor((ctx) => {
			const userId = ctx.from?.id;
			const chatId = ctx.chat?.id;

			return userId === undefined || chatId === undefined ? undefined : `${userId}:${chatId}`;
		});
	}

	/**
	 * Creates a limiter preconfigured with one global scope shared by all updates.
	 *
	 * This is pure builder shorthand for `new Limiter<C>().limitFor('global')`.
	 * It only configures key generation; every other limiter option stays explicit.
	 *
	 * @returns A new limiter builder using the plugin's stable global entity key.
	 */
	public static global<C extends GrammyContext = GrammyContext>(): Limiter<C> {
		return new Limiter<C>().limitFor('global');
	}

	private readonly config: RuleDraft<C, M> = {};
	private readonly events = new EventEmitter<LimiterEvents<C, M>>();

	/** Creates an empty limiter builder. Configure strategy, storage, and scope before building. */
	constructor() {
		this.config.events = this.events;
	}

	/**
	 * Configures the Fixed Window strategy.
	 *
	 * @param options.limit Positive-integer requests per window, or a generator that returns one.
	 * @param options.timeFrame Window duration in milliseconds.
	 * @returns This builder.
	 */
	public fixedWindow(
		options: { limit: number | DynamicLimitGenerator<C>; timeFrame: number },
	): this {
		const { limit, timeFrame } = options;

		if (typeof limit === 'number') {
			const strategy = new FixedWindowStrategy({ limit, timeFrame });

			this.config.strategyResolver = () => strategy;
		} else {
			// Validate the static window duration eagerly. The generated limit itself
			// is validated when the current context is resolved.
			new FixedWindowStrategy({ limit: 1, timeFrame });
			this.config.strategyResolver = (ctx: C) =>
				new FixedWindowStrategy({
					limit: limit(ctx),
					timeFrame,
				});
		}

		this.config.strategyResetter = resetSingleKeyStrategy;
		this.config.strategyKind = 'fixed-window';

		return this;
	}

	/**
	 * Configures the bounded-memory Sliding Window Counter strategy.
	 *
	 * The current fixed bucket counts in full while the immediately previous
	 * bucket is weighted by how much of the current window remains. This smooths
	 * fixed-window boundary bursts while keeping O(1) state per limited key.
	 *
	 * `limit` and `cost` may be generated from the current grammY context. `cost`
	 * defaults to `1`. `timeFrame` is intentionally static so persisted bucket
	 * boundaries remain stable for a key across updates.
	 *
	 * @param options Static window duration plus static or context-aware limit/cost.
	 * @returns This builder.
	 */
	public slidingWindow(options: SlidingWindowOptions<C>): this {
		const { limit, timeFrame, cost = 1 } = options;

		this.config.strategyResetter = resetSingleKeyStrategy;
		this.config.strategyKind = 'sliding-window';

		if (typeof limit === 'number' && typeof cost === 'number') {
			const strategy = new SlidingWindowStrategy({ limit, timeFrame, cost });

			this.config.strategyResolver = () => strategy;

			return this;
		}

		// Validate all static values eagerly without making assumptions about
		// context-generated values that are resolved per matching update.
		const validationCost = typeof cost === 'number' ? cost : 1;
		const validationLimit = typeof limit === 'number' ? limit : Math.max(1, validationCost);

		new SlidingWindowStrategy({
			limit: validationLimit,
			timeFrame,
			cost: validationCost,
		});

		this.config.strategyResolver = (ctx: C) =>
			new SlidingWindowStrategy({
				limit: resolveNumericOption(limit, ctx),
				timeFrame,
				cost: resolveNumericOption(cost, ctx),
			});

		return this;
	}

	/**
	 * Configures the Token Bucket strategy.
	 *
	 * `bucketSize` controls burst capacity. `tokensPerInterval` and `interval`
	 * control the sustained refill rate. `cost` defaults to one token and may be
	 * increased for expensive updates.
	 *
	 * Every option may be a number or a context-aware generator. Static
	 * configurations are validated when this method is called; generated values
	 * are resolved and validated for each matching update.
	 *
	 * @param options Static or context-aware token-bucket configuration.
	 * @returns This builder.
	 */
	public tokenBucket(options: TokenBucketOptions<C>): this {
		const { bucketSize, tokensPerInterval, interval, cost = 1 } = options;

		this.config.strategyResetter = resetSingleKeyStrategy;
		this.config.strategyKind = 'token-bucket';

		if (
			typeof bucketSize === 'number' &&
			typeof tokensPerInterval === 'number' &&
			typeof interval === 'number' &&
			typeof cost === 'number'
		) {
			const strategy = new TokenBucketStrategy({
				bucketSize,
				tokensPerInterval,
				interval,
				cost,
			});

			this.config.strategyResolver = () => strategy;

			return this;
		}

		this.config.strategyResolver = (ctx: C) =>
			new TokenBucketStrategy({
				bucketSize: resolveNumericOption(bucketSize, ctx),
				tokensPerInterval: resolveNumericOption(tokensPerInterval, ctx),
				interval: resolveNumericOption(interval, ctx),
				cost: resolveNumericOption(cost, ctx),
			});

		return this;
	}

	/**
	 * Configures the Generic Cell Rate Algorithm (GCRA) strategy.
	 *
	 * GCRA provides smooth rate enforcement without fixed-window boundary bursts.
	 * `rate` is the sustained number of cost units admitted per `interval`,
	 * `burst` is the maximum cost capacity available immediately after the key has
	 * been idle long enough, and `cost` defaults to one unit per matching update.
	 *
	 * Every option may be static or generated from the current grammY context.
	 * Static configurations are validated immediately; generated values are
	 * resolved and validated for each matching update.
	 *
	 * @param options Static or context-aware GCRA configuration.
	 * @returns This builder.
	 */
	public gcra(options: GcraOptions<C>): this {
		const { rate, interval, burst, cost = 1 } = options;

		this.config.strategyResetter = resetSingleKeyStrategy;
		this.config.strategyKind = 'gcra';

		if (
			typeof rate === 'number' &&
			typeof interval === 'number' &&
			typeof burst === 'number' &&
			typeof cost === 'number'
		) {
			const strategy = new GcraStrategy({ rate, interval, burst, cost });

			this.config.strategyResolver = () => strategy;

			return this;
		}

		this.config.strategyResolver = (ctx: C) =>
			new GcraStrategy({
				rate: resolveNumericOption(rate, ctx),
				interval: resolveNumericOption(interval, ctx),
				burst: resolveNumericOption(burst, ctx),
				cost: resolveNumericOption(cost, ctx),
			});

		return this;
	}

	/**
	 * Configures a true per-entity cooldown between matching actions.
	 *
	 * A cooldown allows one action immediately, then requires the full resolved
	 * duration to elapse before the next action for the same limiter key may pass.
	 * Unlike a Fixed Window with `limit: 1`, it cannot admit two actions close
	 * together on opposite sides of a window boundary.
	 *
	 * Cooldown is a high-level DX primitive backed by GCRA with a rate, burst, and
	 * cost of one. It therefore inherits GCRA's atomic Memory/Redis behavior,
	 * server-time semantics in Redis, inspection, reset, refund, and atomic
	 * composition support without introducing another storage algorithm.
	 *
	 * @param duration Minimum interval in milliseconds, or a context-aware resolver.
	 * The resolved value must be a positive integer.
	 * @returns This builder.
	 */
	public cooldown(duration: number | CooldownDurationGenerator<C>): this {
		this.gcra({ rate: 1, interval: duration, burst: 1, cost: 1 });
		this.config.strategyKind = 'cooldown';

		return this;
	}

	/**
	 * Configures a custom limiting strategy.
	 *
	 * The strategy receives the storage engine configured with `useStorage()` on
	 * every matching update.
	 *
	 * @param strategy An object implementing `ILimiterStrategy`.
	 * @returns This builder.
	 */
	public customStrategy(strategy: ILimiterStrategy): this {
		this.config.strategyResolver = () => strategy;
		this.config.strategyKind = 'custom';
		this.config.strategyResetter = strategy.reset === undefined
			? undefined
			: async (key, storage) => {
				await strategy.reset?.(key, storage);
			};

		return this;
	}

	/**
	 * Sets the storage engine for the rule.
	 *
	 * A single storage instance may be shared by multiple rules. Distinct rules
	 * should use distinct key prefixes when sharing a store.
	 *
	 * @param storage Storage engine used for limiter state and penalties.
	 * @returns This builder.
	 */
	public useStorage(storage: IStorageEngine): this {
		this.config.storage = storage;

		return this;
	}

	/**
	 * Defines which entity is rate-limited.
	 *
	 * - `user` uses `ctx.from.id`.
	 * - `chat` uses `ctx.chat.id`.
	 * - `global` shares one key across all matching updates.
	 * - a custom generator may return any key or `undefined` to bypass limiting.
	 *
	 * @param scope Predefined scope or custom key generator.
	 * @returns This builder.
	 */
	public limitFor(scope: 'user' | 'chat' | 'global' | KeyGenerator<C>): this {
		if (typeof scope === 'function') {
			this.config.keyGenerator = scope;
		} else {
			switch (scope) {
				case 'user':
					this.config.keyGenerator = (ctx: C) => ctx.from?.id.toString();
					break;
				case 'chat':
					this.config.keyGenerator = (ctx: C) => ctx.chat?.id.toString();
					break;
				case 'global':
					this.config.keyGenerator = () => GLOBAL_SCOPE_KEY;
					break;
			}
		}

		return this;
	}

	/**
	 * Registers a synchronous limiter event listener.
	 *
	 * Listener exceptions propagate through the middleware call.
	 *
	 * @param eventName Event to observe.
	 * @param listener Callback invoked when the event is emitted.
	 * @returns This builder.
	 */
	public on<E extends keyof LimiterEvents<C, M>>(
		eventName: E,
		listener: (...args: LimiterEvents<C, M>[E]) => void,
	): this {
		this.events.on(eventName, listener);

		return this;
	}

	/**
	 * Unregisters a previously registered limiter event listener.
	 *
	 * @param eventName Event the listener was registered for.
	 * @param listener Exact callback reference passed to `on()`.
	 * @returns This builder.
	 */
	public off<E extends keyof LimiterEvents<C, M>>(
		eventName: E,
		listener: (...args: LimiterEvents<C, M>[E]) => void,
	): this {
		this.events.off(eventName, listener);

		return this;
	}

	/**
	 * Assigns an optional human-readable name to this limiter rule.
	 *
	 * Names do not affect storage keys, limiting behavior, or rule ordering. They
	 * are carried into structured decisions and inspection results so logs,
	 * metrics, diagnostics, and composite limiters can identify the rule that
	 * produced a result without coupling observability to key-prefix conventions.
	 *
	 * Calling this method again replaces the previous name. The final value is
	 * snapshotted by `build()` and exposed as the read-only `Rule.name`.
	 *
	 * @param name Non-empty, non-whitespace rule name.
	 * @returns This builder.
	 */
	public withName(name: string): this {
		if (name.trim().length === 0) {
			throw new Error('Limiter: rule name must not be empty or whitespace.');
		}

		this.config.name = name;

		return this;
	}

	/**
	 * Enables opt-in structured identity metadata for `decision` events and
	 * `LimiterMiddleware.inspect()` results.
	 *
	 * `ctx.from.id` and `ctx.chat.id` are captured automatically when present.
	 * No names, usernames, message contents, or other profile data are collected.
	 * Metadata is not resolved at all unless this method is called. During normal
	 * middleware execution it is resolved lazily only when a `decision` listener
	 * exists, keeping the unobserved hot path unchanged.
	 *
	 * A synchronous resolver may add application-specific identity such as a
	 * tenant, account, shard, or plan. Custom fields are nested under `custom`, so
	 * they cannot overwrite the built-in Telegram identifiers. The resolver's
	 * return type flows into decision and inspection metadata for editor inference.
	 *
	 * This method may be called at most once per builder.
	 *
	 * @returns This builder with rich metadata reflected in its TypeScript type.
	 */
	public withMetadata(): Limiter<C, Readonly<Record<never, never>>>;

	/**
	 * Enables rich metadata and adds type-inferred custom identity fields.
	 *
	 * @param resolver Lightweight synchronous resolver for application identity.
	 * @returns This builder with the resolver result reflected in metadata types.
	 */
	public withMetadata<N extends LimiterMetadataFields>(
		resolver: LimiterMetadataResolver<C, N>,
	): Limiter<C, N>;

	/** @internal Implementation signature for the public metadata overloads above. */
	public withMetadata<N extends LimiterMetadataFields>(
		resolver?: LimiterMetadataResolver<C, N>,
	): Limiter<C, N> {
		if (this.config.metadata !== undefined) {
			throw new Error('Limiter: rich metadata is already configured for this rule.');
		}

		const config = this.config as unknown as RuleDraft<C, N>;

		config.metadata = resolver === undefined ? {} : { resolver };

		return this as unknown as Limiter<C, N>;
	}

	/**
	 * Sets the prefix prepended to strategy storage keys.
	 *
	 * Use a unique prefix for each logical rule when several rules share one
	 * storage engine to prevent state collisions.
	 *
	 * @param prefix Storage key prefix.
	 * @returns This builder.
	 */
	public withKeyPrefix(prefix: string): this {
		if (prefix.length === 0) {
			throw new Error('Limiter: key prefix must not be empty.');
		}

		this.config.keyPrefix = prefix;

		return this;
	}

	/**
	 * Applies the limiter only when the predicate resolves to `true`.
	 *
	 * The predicate runs before key generation, penalty lookup, and strategy
	 * storage operations. Returning `false` fully bypasses this limiter rule.
	 *
	 * @param predicate Synchronous or asynchronous applicability predicate.
	 * @returns This builder.
	 */
	public onlyIf(predicate: (ctx: C) => boolean | Promise<boolean>): this {
		this.config.filter = predicate;

		return this;
	}

	/**
	 * Defines a callback invoked whenever the strategy throttles an update.
	 *
	 * Returned promises are awaited before an optional penalty is applied. The
	 * callback is skipped in observe-only mode to avoid user-visible side effects.
	 *
	 * @param handler Synchronous or asynchronous throttling handler.
	 * @returns This builder.
	 */
	public onThrottled(handler: OnLimitExceeded<C>): this {
		this.config.onLimitExceeded = handler;

		return this;
	}

	/**
	 * Enables observe-only mode for this rule.
	 *
	 * Observe-only rules evaluate the same strategy and penalty state as enforced
	 * rules, but never block downstream middleware because of a limiter decision.
	 * Strategy and penalty state is written under an isolated shadow namespace so
	 * a production dry run cannot consume or create enforcement state.
	 *
	 * `onThrottled()` is intentionally not called in observe-only mode because it
	 * commonly performs user-visible enforcement side effects. Use the typed
	 * `decision` event for logs, metrics, and traces of what would have happened.
	 *
	 * Storage errors still follow `withStorageFailurePolicy()`. A `throw` policy
	 * continues to surface backend failures; non-throwing policies are observed
	 * without blocking downstream middleware.
	 *
	 * @returns This builder.
	 */
	public observeOnly(): this {
		this.config.mode = 'observe';

		return this;
	}

	/**
	 * Configures how limiter-owned storage failures are handled.
	 *
	 * The default is `throw`, which preserves the underlying storage error.
	 * `fail-open` prioritizes availability, while `fail-closed` prioritizes
	 * protection when limiter state cannot be read safely. An async resolver may
	 * choose a mode per context, storage operation, and middleware phase.
	 *
	 * Only storage calls made by limiter internals and strategies are covered.
	 * Storage calls performed manually inside user callbacks remain application
	 * responsibility and propagate normally.
	 *
	 * @param policy Static mode or context-aware policy resolver.
	 * @returns This builder.
	 */
	public withStorageFailurePolicy(policy: StorageFailurePolicy<C>): this {
		this.config.storageFailurePolicy = policy;

		return this;
	}

	/**
	 * Enables the penalty-box feature.
	 *
	 * After a strategy throttles an update, the configured duration is stored
	 * under a separate penalty key. While that marker exists, subsequent matching
	 * updates for the same entity are dropped before strategy evaluation.
	 *
	 * A dynamic generator may return `0` or a negative value to skip applying a
	 * penalty for a particular throttled update.
	 *
	 * @param options.penaltyTime Fixed duration or context-dependent duration in milliseconds.
	 * Positive fractional durations are rounded up before being stored.
	 * @param options.penaltyKeyPrefix Optional non-empty prefix for penalty keys. When omitted,
	 * the rule uses `<keyPrefix>:PENALTY`, which keeps penalties isolated between rules.
	 * Escalation strike state derives from the same penalty namespace.
	 * @param options.escalation Optional geometric strike escalation. Only new strategy
	 * throttles add strikes; requests blocked by an active penalty do not. Strike history
	 * expires after `resetAfter` milliseconds of inactivity.
	 * @returns This builder.
	 */
	public withPenalty(options: PenaltyOptions<C>): this {
		if (options.penaltyKeyPrefix !== undefined && options.penaltyKeyPrefix.length === 0) {
			throw new Error('Limiter: penalty key prefix must not be empty.');
		}

		let generator: PenaltyDurationGenerator<C>;

		if (typeof options.penaltyTime === 'number') {
			if (!Number.isFinite(options.penaltyTime) || options.penaltyTime < 0) {
				throw new Error('Limiter: penaltyTime must be a finite, non-negative number.');
			}

			const penaltyValue = options.penaltyTime;

			generator = (_ctx: C, _info: LimitResult) => penaltyValue;
		} else {
			generator = options.penaltyTime;
		}

		let escalation: PenaltyEscalationDraft | undefined;

		if (options.escalation !== undefined) {
			const factor = options.escalation.factor ?? 2;

			if (!Number.isFinite(factor) || factor <= 1) {
				throw new Error(
					'Limiter: penalty escalation factor must be finite and greater than 1.',
				);
			}

			if (
				!Number.isFinite(options.escalation.maxPenaltyTime) ||
				options.escalation.maxPenaltyTime <= 0
			) {
				throw new Error(
					'Limiter: penalty escalation maxPenaltyTime must be a finite positive number.',
				);
			}

			if (
				!Number.isInteger(options.escalation.resetAfter) ||
				options.escalation.resetAfter <= 0
			) {
				throw new Error(
					'Limiter: penalty escalation resetAfter must be a positive integer.',
				);
			}

			escalation = {
				factor,
				maxPenaltyTime: Math.ceil(options.escalation.maxPenaltyTime),
				resetAfter: options.escalation.resetAfter,
			};
		}

		this.config.penalty = {
			generator,
			...(options.penaltyKeyPrefix === undefined ? {} : {
				keyPrefix: options.penaltyKeyPrefix,
			}),
			...(escalation === undefined ? {} : { escalation }),
		};

		return this;
	}

	/**
	 * Finalizes and validates the current configuration.
	 *
	 * Strategy/storage references and listener registrations are snapshotted into
	 * the resulting rule. Later builder reconfiguration does not change that rule.
	 *
	 * @returns A validated, read-only `Rule` ready to pass to `limit()`.
	 * @throws If a strategy, storage engine, or key-generation strategy is missing.
	 */
	public build(): Rule<C, M> {
		const rule = new Rule<C, M>(this.config);

		if (!this.config.keyPrefix) {
			console.warn(
				`
[grammy-ratelimiter] WARNING: No .withKeyPrefix() was set for this limiter.
Using the default prefix is not recommended when using multiple limiters, as it can lead to data collisions.
Please assign a unique prefix for each rule, e.g., .withKeyPrefix('my-rule').

`,
			);
		}

		return rule;
	}
}
