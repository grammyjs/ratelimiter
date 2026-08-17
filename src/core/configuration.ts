import type { EventEmitter } from '../lib/event_emitter.ts';

import type {
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimiterEvents,
	LimiterMetadataFields,
	LimiterMetadataResolver,
	LimiterMode,
	LimiterStrategyKind,
	OnLimitExceeded,
	PenaltyDurationGenerator,
	PenaltyEscalationOptions,
	StorageFailurePolicy,
} from '../types.ts';

/** Default prefix for limiter strategy state. */
export const DEFAULT_KEY_PREFIX = 'GRAMMY:RATELIMITER';

/** Segment appended to a rule prefix for its default penalty namespace. */
export const PENALTY_KEY_SEGMENT = 'PENALTY';

/** Segment appended to a penalty prefix for strike/escalation state. */
export const PENALTY_STRIKE_KEY_SEGMENT = 'STRIKES';

/** Internal entity key used by the built-in global scope. */
export const GLOBAL_SCOPE_KEY = '___GLOBAL___';

/** Storage namespace segment used by observe-only shadow state. */
export const OBSERVE_KEY_SEGMENT = '__OBSERVE__';

/** @internal Resolves the effective strategy for one grammY context. */
export type StrategyResolver<C extends GrammyContext> = (ctx: C) => ILimiterStrategy;

/** @internal Clears all state owned by one configured strategy key. */
export type StrategyResetter = (key: string, storage: IStorageEngine) => Promise<void>;

/** @internal Opt-in structured metadata configuration captured by a built rule. */
export interface MetadataConfig<
	C extends GrammyContext,
	M extends LimiterMetadataFields,
> {
	readonly resolver?: LimiterMetadataResolver<C, M>;
}

/** @internal Normalized strike-escalation configuration stored by a built rule. */
export interface PenaltyEscalationConfig extends Required<PenaltyEscalationOptions> {
	readonly keyPrefix: string;
}

/** @internal Escalation configuration before its strike namespace is derived. */
export type PenaltyEscalationDraft = Omit<PenaltyEscalationConfig, 'keyPrefix'>;

/** @internal Penalty configuration collected by the builder before rule normalization. */
export interface PenaltyDraft<C extends GrammyContext> {
	readonly generator: PenaltyDurationGenerator<C>;
	readonly keyPrefix?: string;
	readonly escalation?: PenaltyEscalationDraft;
}

/** @internal Normalized penalty configuration stored by a built rule. */
export interface PenaltyConfig<C extends GrammyContext> {
	readonly generator: PenaltyDurationGenerator<C>;
	readonly keyPrefix: string;
	readonly escalation?: Readonly<PenaltyEscalationConfig>;
}

/**
 * @internal Mutable draft collected by `Limiter` before `build()` validates and
 * snapshots it into a `Rule`.
 *
 * Keeping this separate from `Rule` prevents the builder's partially configured
 * state from being confused with the validated runtime representation.
 */
export interface RuleDraft<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
> {
	name?: string;
	metadata?: MetadataConfig<C, LimiterMetadataFields>;
	strategyResolver?: StrategyResolver<C>;
	strategyKind?: LimiterStrategyKind;
	strategyResetter?: StrategyResetter;
	storage?: IStorageEngine;
	keyGenerator?: KeyGenerator<C>;
	events?: EventEmitter<LimiterEvents<C, M>>;
	keyPrefix?: string;
	filter?: (ctx: C) => boolean | Promise<boolean>;
	onLimitExceeded?: OnLimitExceeded<C>;
	penalty?: PenaltyDraft<C>;
	storageFailurePolicy?: StorageFailurePolicy<C>;
	mode?: LimiterMode;
}
