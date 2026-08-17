/**
 * # Rate Limiter for grammY
 *
 * Main entry point for the grammY 2 rate-limiter middleware, builder, built-in
 * strategies, and public strategy/storage contracts.
 *
 * Storage engines are exported separately from `@grammyjs/ratelimiter/storages`.
 *
 * @module
 */

export { limit } from './src/core/middleware.ts';
export { limitAll, type LimitLayer } from './src/core/composite.ts';
export { limitAllAtomic } from './src/core/atomic_composite.ts';
export { Limiter } from './src/core/builder.ts';
export {
	defineLimiterPreset,
	LimiterPreset,
	type LimiterPresetFactory,
} from './src/core/preset.ts';
export { Rule } from './src/core/rule.ts';

export {
	FixedWindowStrategy,
	type FixedWindowStrategyOptions,
} from './src/strategies/fixed_window.ts';
export {
	TokenBucketStrategy,
	type TokenBucketStrategyOptions,
} from './src/strategies/token_bucket.ts';
export { GcraStrategy, type GcraStrategyOptions } from './src/strategies/gcra.ts';
export {
	SlidingWindowStrategy,
	type SlidingWindowStrategyOptions,
} from './src/strategies/sliding_window.ts';

export type {
	AtomicFixedWindowOperation,
	AtomicGcraOperation,
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	AtomicLimitOperation,
	AtomicSlidingWindowOperation,
	AtomicTokenBucketOperation,
	CooldownDurationGenerator,
	DynamicLimitGenerator,
	FixedWindowIncrementResult,
	FixedWindowPreviewOptions,
	GcraConsumeOptions,
	GcraConsumeResult,
	GcraCostGenerator,
	GcraOptionGenerator,
	GcraOptions,
	GrammyContext,
	IAtomicLimitStorage,
	IFixedWindowStorage,
	IGcraStorage,
	ILimiterInspectionStorage,
	ILimiterRefundStorage,
	ILimiterStrategy,
	IPenaltyEscalationStorage,
	IPenaltyStorage,
	ISlidingWindowStorage,
	IStateStorage,
	IStorageEngine,
	ITokenBucketStorage,
	KeyGenerator,
	LimiterBypassInfo,
	LimiterBypassReason,
	LimiterCompositeDiagnostic,
	LimiterCompositeDiagnosticLayer,
	LimiterCompositeMiddleware,
	LimiterConsumer,
	LimiterConsumeResult,
	LimiterControls,
	LimiterDecision,
	LimiterDecisionMetric,
	LimiterDiagnostic,
	LimiterDiagnostics,
	LimiterEvents,
	LimiterInspection,
	LimiterMetadata,
	LimiterMetadataFields,
	LimiterMetadataResolver,
	LimiterMetric,
	LimiterMetricSource,
	LimiterMiddleware,
	LimiterMode,
	LimiterPenaltyEscalationInspection,
	LimiterPenaltyInspection,
	LimiterRefunder,
	LimiterRefundMetric,
	LimiterStorageFailurePolicyDiagnostic,
	LimiterStrategyDiagnostic,
	LimiterStrategyInspection,
	LimiterStrategyKind,
	LimitResult,
	NextFunction,
	OnLimitExceeded,
	PenaltyDurationGenerator,
	PenaltyEscalationApplyOptions,
	PenaltyEscalationOptions,
	PenaltyEscalationResult,
	PenaltyOptions,
	PenaltyStrikeState,
	SlidingWindowConsumeOptions,
	SlidingWindowConsumeResult,
	SlidingWindowCostGenerator,
	SlidingWindowOptionGenerator,
	SlidingWindowOptions,
	StorageFailureInfo,
	StorageFailureMode,
	StorageFailurePhase,
	StorageFailurePolicy,
	StorageFailurePolicyResolver,
	StorageOperation,
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
	TokenBucketOptionGenerator,
	TokenBucketOptions,
	TokenCostGenerator,
} from './src/types.ts';
