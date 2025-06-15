/**
 * # Rate Limiter for grammY
 *
 * This is the main entry point for the grammY rate-limiter middleware.
 *
 * @module
 */

export { limit } from './src/core/middleware.ts';
export { Limiter } from './src/core/builder.ts';

// available strategies.
export { FixedWindowStrategy, type FixedWindowStrategyOptions } from './src/strategies/fixed_window.ts';
export { TokenBucketStrategy, type TokenBucketStrategyOptions } from './src/strategies/token_bucket.ts';

// all core types and interfaces that developers might need for type annotations.
export type {
	GrammyContext,
	ILimiterStrategy,
	IStorageEngine,
	KeyGenerator,
	LimitResult,
	NextFunction,
	OnLimitExceeded,
	PenaltyDurationGenerator,
} from './src/types.ts';
