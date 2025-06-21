import { Rule } from './rule.ts';
import { EventEmitter } from '../lib/event_emitter.ts';
import { FixedWindowStrategy } from '../strategies/fixed_window.ts';
import { TokenBucketStrategy } from '../strategies/token_bucket.ts';
import type {
	DynamicLimitGenerator,
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimiterEvents,
	LimitResult,
	Mutable,
	OnLimitExceeded,
	PenaltyDurationGenerator,
} from '../types.ts';

/**
 * A fluent API builder for constructing rate-limiter rules.
 */
export class Limiter<C extends GrammyContext> {
	private config: Partial<Mutable<Rule<C>>> = {};
	private readonly events = new EventEmitter<LimiterEvents<C>>();

	constructor() {
		this.config.events = this.events;
	}

	/**
	 * Sets the limiting strategy to Fixed Window.
	 * @param options The configuration for the fixed window.
	 */
	public fixedWindow(
		options: { limit: number | DynamicLimitGenerator<C>; timeFrame: number },
	): this {
		this.config.strategy = new FixedWindowStrategy({
			limit: typeof options.limit === 'number' ? options.limit : 1,
			timeFrame: options.timeFrame,
		});

		if (typeof options.limit !== 'number') {
			this.config.dynamicLimitGenerator = options.limit;
		}

		return this;
	}

	/**
	 * Sets the limiting strategy to Token Bucket.
	 * @param options The configuration for the token bucket.
	 */
	public tokenBucket(
		options: { bucketSize: number; tokensPerInterval: number; interval: number },
	): this {
		this.config.strategy = new TokenBucketStrategy(options);
		return this;
	}

	/**
	 * Sets a custom limiting strategy.
	 * @param strategy An instance of a class that implements `ILimiterStrategy`.
	 */
	public customStrategy(strategy: ILimiterStrategy<unknown>): this {
		this.config.strategy = strategy;
		return this;
	}

	/**
	 * Sets the storage engine for the rule.
	 *
	 * @param storage An instance of a storage engine.
	 */
	public useStorage(storage: IStorageEngine): this {
		this.config.storage = storage;
		return this;
	}

	/**
	 * Defines what entity to rate-limit.
	 *
	 * @param scope A predefined scope ("user", "chat", "global") or a custom key generator function.
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
					this.config.keyGenerator = () => '___GLOBAL___';
					break;
			}
		}

		return this;
	}

	/**
	 * Registers an event listener for this limiter instance.
	 * This allows for observing the limiter's behavior for logging or analytics.
	 *
	 * @param eventName The event to listen for.
	 * @param listener The callback function.
	 */
	public on<E extends keyof LimiterEvents<C>>(
		eventName: E,
		listener: (...args: LimiterEvents<C>[E]) => void,
	): this {
		this.events.on(eventName, listener);
		return this;
	}

	/**
	 * Unregisters an event listener.
	 * @param eventName The event to stop listening for.
	 * @param listener The callback function to remove.
	 */
	public off<E extends keyof LimiterEvents<C>>(
		eventName: E,
		listener: (...args: LimiterEvents<C>[E]) => void,
	): this {
		this.events.off(eventName, listener);
		return this;
	}

	/**
	 * Sets a prefix for all keys generated for this rule.
	 * Useful for preventing key collisions between different rules in the same storage.
	 *
	 * @param prefix The string to prepend to the key.
	 */
	public withKeyPrefix(prefix: string): this {
		this.config.keyPrefix = prefix;
		return this;
	}

	/**
	 * Rate limiter will only run if this function returns `true`.
	 *
	 * @param predicate A function that takes the context and returns a boolean.
	 */
	public onlyIf(predicate: (ctx: C) => boolean | Promise<boolean>): this {
		this.config.filter = predicate;
		return this;
	}

	/**
	 * Defines the callback to execute when a request is throttled (rate-limited).
	 *
	 * @param handler The function to call when the limit is exceeded.
	 */
	public onThrottled(handler: OnLimitExceeded<C>): this {
		this.config.onLimitExceeded = handler;
		return this;
	}

	/**
	 * Enables and configures the "Penalty Box" feature.
	 *
	 * @param options The penalty configuration.
	 */
	public withPenalty(
		options: { penaltyTime: number | PenaltyDurationGenerator<C>; penaltyKeyPrefix?: string },
	): this {
		let generator: PenaltyDurationGenerator<C>;

		if (typeof options.penaltyTime === 'number') {
			const penaltyValue = options.penaltyTime;
			generator = (_ctx: C, _info: LimitResult) => penaltyValue;
		} else {
			generator = options.penaltyTime;
		}

		this.config.penalty = {
			generator: generator,
			keyPrefix: options.penaltyKeyPrefix ?? 'GRAMMY:RATELIMITER:PENALTY',
		};

		return this;
	}

	/**
	 * Finalizes the configuration and returns a validated `Rule` instance.
	 */
	public build(): Rule<C> {
		if (!this.config.keyPrefix) {
			console.warn(
				`
[grammy-ratelimiter] WARNING: No .withKeyPrefix() was set for this limiter.
Using the default prefix is not recommended when using multiple limiters, as it can lead to data collisions.
Please assign a unique prefix for each rule, e.g., .withKeyPrefix('my-rule').

`,
			);
		}

		return new Rule<C>(this.config);
	}
}
