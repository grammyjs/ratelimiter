import type { EventEmitter } from '../lib/event_emitter.ts';
import type {
	DynamicLimitGenerator,
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimiterEvents,
	OnLimitExceeded,
	PenaltyDurationGenerator,
} from '../types.ts';

/**
 * Represents a ready-to-use rate-limiting rule.
 *
 * **NOTE**: The properties are read-only so you cannot modify them after construction.
 */
export class Rule<C extends GrammyContext> {
	public readonly strategy: ILimiterStrategy<unknown>;
	public readonly storage: IStorageEngine;
	public readonly keyGenerator: KeyGenerator<C>;
	public readonly events: EventEmitter<LimiterEvents<C>>;
	public readonly keyPrefix: string;
	public readonly onLimitExceeded: OnLimitExceeded<C>;

	// determines if the limiter should run for a given request.
	public readonly filter: (ctx: C) => boolean | Promise<boolean>;

	// dynamically determines the limit for Fixed Window strategies.
	public readonly dynamicLimitGenerator?: DynamicLimitGenerator<C>;

	public readonly penalty?: {
		generator: PenaltyDurationGenerator<C>;
		keyPrefix: string;
	};

	constructor(config: Partial<Rule<C>>) {
		if (!config.strategy) {
			throw new Error(
				'Cannot build rule: A limiting strategy must be defined. Use .fixedWindow(), .tokenBucket(), or .customStrategy() on the builder.',
			);
		}

		if (!config.storage) {
			throw new Error(
				'Cannot build rule: A storage engine must be provided. Use .useStorage() on the builder. It is recommended to create one store instance and share it across all rules.',
			);
		}

		if (!config.keyGenerator) {
			throw new Error(
				'Cannot build rule: A key generation strategy must be defined. Use .limitFor() on the builder.',
			);
		}

		if (!config.events) {
			throw new Error('[INTERNAL] Cannot build rule: An event emitter instance is missing.');
		}

		this.strategy = config.strategy;
		this.storage = config.storage;
		this.keyGenerator = config.keyGenerator;
		this.events = config.events;
		this.keyPrefix = config.keyPrefix ?? 'GRAMMY:RATELIMITER';
		this.filter = config.filter ?? (() => true);
		this.onLimitExceeded = config.onLimitExceeded ?? (() => {});
		this.dynamicLimitGenerator = config.dynamicLimitGenerator;
		this.penalty = config.penalty;
	}
}
