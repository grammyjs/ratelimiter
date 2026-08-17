import type { EventEmitter } from '../lib/event_emitter.ts';

import type {
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimiterEvents,
	LimiterMetadata,
	LimiterMetadataFields,
	LimiterMode,
	LimiterStrategyKind,
	OnLimitExceeded,
	StorageFailurePolicy,
} from '../types.ts';

import {
	DEFAULT_KEY_PREFIX,
	PENALTY_KEY_SEGMENT,
	PENALTY_STRIKE_KEY_SEGMENT,
	type PenaltyConfig,
	type RuleDraft,
	type StrategyResetter,
	type StrategyResolver,
} from './configuration.ts';

/**
 * Validated runtime representation of one rate-limiting rule.
 *
 * Applications normally create rules through the fluent `Limiter` builder.
 * `build()` snapshots the builder configuration, including its event-listener
 * registrations, so later builder changes do not mutate an already-built rule.
 *
 * Strategy selection is represented by a resolver. Static strategies simply
 * resolve to the same instance for every update, while dynamic built-in
 * strategies resolve a validated strategy from the current grammY context. The
 * rule also snapshots whether decisions are enforced or measured in observe-only
 * shadow state.
 */
export class Rule<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
> {
	/** Optional human-readable identity used by observability and diagnostics. */
	public readonly name?: string;

	/** Stable high-level strategy identity used by explicit diagnostics. */
	public readonly strategyKind: LimiterStrategyKind;

	/** Storage engine shared by the rule's strategy and penalty handling. */
	public readonly storage: IStorageEngine;

	/** Produces the entity-specific storage key or `undefined` to bypass limiting. */
	public readonly keyGenerator: KeyGenerator<C>;

	/** @internal Event-listener snapshot captured when the rule was built. */
	public readonly events: EventEmitter<LimiterEvents<C, M>>;

	/** Prefix prepended to strategy storage keys. */
	public readonly keyPrefix: string;

	/** Callback invoked after a strategy throttles an update. */
	public readonly onLimitExceeded: OnLimitExceeded<C>;

	/** Predicate evaluated before key generation, penalty checks, and strategy work. */
	public readonly filter: (ctx: C) => boolean | Promise<boolean>;

	/** @internal Optional, read-only penalty-box configuration. */
	public readonly penalty?: Readonly<PenaltyConfig<C>>;

	/** Policy used when limiter-owned storage access fails. Defaults to `throw`. */
	public readonly storageFailurePolicy: StorageFailurePolicy<C>;

	/** Whether limiter decisions are enforced or measured using isolated shadow state. */
	public readonly mode: LimiterMode;

	private readonly strategyResolver: StrategyResolver<C>;
	private readonly metadataConfig?: RuleDraft<C, M>['metadata'];
	private readonly strategyResetter?: StrategyResetter;

	/**
	 * @internal Constructs a validated rule from a builder draft.
	 *
	 * @param draft Partially configured builder state.
	 * @throws If the strategy, storage engine, key generator, or internal event emitter is missing.
	 */
	constructor(draft: RuleDraft<C, M>) {
		if (!draft.strategyResolver) {
			throw new Error(
				'Cannot build rule: A limiting strategy must be defined. Use .fixedWindow(), .slidingWindow(), .tokenBucket(), .gcra(), or .customStrategy() on the builder.',
			);
		}

		if (!draft.storage) {
			throw new Error(
				'Cannot build rule: A storage engine must be provided. Use .useStorage() on the builder. It is recommended to create one store instance and share it across all rules.',
			);
		}

		if (!draft.keyGenerator) {
			throw new Error(
				'Cannot build rule: A key generation strategy must be defined. Use .limitFor() on the builder.',
			);
		}

		if (!draft.events) {
			throw new Error('[INTERNAL] Cannot build rule: An event emitter instance is missing.');
		}

		this.name = draft.name;
		this.metadataConfig = draft.metadata === undefined
			? undefined
			: Object.freeze({ ...draft.metadata });
		this.strategyResolver = draft.strategyResolver;
		this.strategyKind = draft.strategyKind ?? 'custom';
		this.strategyResetter = draft.strategyResetter;
		this.storage = draft.storage;
		this.keyGenerator = draft.keyGenerator;
		this.events = draft.events.clone();
		this.keyPrefix = draft.keyPrefix ?? DEFAULT_KEY_PREFIX;
		this.filter = draft.filter ?? (() => true);
		this.onLimitExceeded = draft.onLimitExceeded ?? (() => {});
		this.storageFailurePolicy = draft.storageFailurePolicy ?? 'throw';
		this.mode = draft.mode ?? 'enforce';

		if (draft.penalty === undefined) {
			this.penalty = undefined;
		} else {
			const keyPrefix = draft.penalty.keyPrefix ?? `${this.keyPrefix}:${PENALTY_KEY_SEGMENT}`;

			this.penalty = Object.freeze({
				generator: draft.penalty.generator,
				keyPrefix,
				escalation: draft.penalty.escalation === undefined ? undefined : Object.freeze({
					...draft.penalty.escalation,
					keyPrefix: `${keyPrefix}:${PENALTY_STRIKE_KEY_SEGMENT}`,
				}),
			});
		}
	}

	/**
	 * Resolves the strategy that applies to the current context.
	 *
	 * Static strategies return the same instance on every call. Dynamic built-in
	 * strategies validate their context-derived values while resolving.
	 *
	 * @param ctx Current grammY context.
	 */
	public resolveStrategy(ctx: C): ILimiterStrategy {
		return this.strategyResolver(ctx);
	}

	/**
	 * @internal Resolves opt-in structured identity metadata for one context.
	 *
	 * Returns `undefined` when metadata was not enabled. Only stable Telegram IDs
	 * are captured automatically; custom data comes exclusively from the explicit
	 * resolver configured with `withMetadata(resolver)`.
	 */
	public resolveMetadata(
		ctx: C,
	): LimiterMetadata<Exclude<M, undefined>> | undefined {
		if (this.metadataConfig === undefined) {
			return undefined;
		}

		const custom = this.metadataConfig.resolver?.(ctx);

		if (
			custom !== undefined &&
			(custom === null || typeof custom !== 'object' || Array.isArray(custom))
		) {
			throw new Error('Limiter: metadata resolver must return a plain object.');
		}

		const metadata: LimiterMetadata<Exclude<M, undefined>> = {
			...(ctx.from?.id === undefined ? {} : { userId: ctx.from.id }),
			...(ctx.chat?.id === undefined ? {} : { chatId: ctx.chat.id }),
			...(custom === undefined ? {} : {
				custom: Object.freeze({ ...custom }) as Readonly<Exclude<M, undefined>>,
			}),
		};

		return Object.freeze(metadata);
	}

	/**
	 * @internal Clears strategy-owned state for one fully resolved storage key.
	 *
	 * Returns `false` when the configured custom strategy does not expose a safe
	 * reset capability. Built-in strategies always support this operation.
	 */
	public async resetStrategy(key: string): Promise<boolean> {
		if (this.strategyResetter === undefined) {
			return false;
		}

		await this.strategyResetter(key, this.storage);

		return true;
	}
}
