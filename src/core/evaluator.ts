import type { Rule } from './rule.ts';

import { OBSERVE_KEY_SEGMENT } from './configuration.ts';
import { resolveStorageFailure } from './storage_failure.ts';
import { guardStorage, StorageOperationError } from './storage_guard.ts';

import type {
	AtomicLimitConsumeResult,
	GrammyContext,
	LimiterBypassInfo,
	LimiterConsumeResult,
	LimiterDecision,
	LimiterMetadataFields,
	LimitResult,
	StorageFailureMode,
	StorageFailurePhase,
} from '../types.ts';

/** Runtime namespaces derived once from one immutable rule. */
export interface RuleRuntimeNamespaces {
	/** Strategy namespace, including the observe-only segment when applicable. */
	readonly strategyPrefix: string;
	/** Penalty namespace, including the observe-only segment when applicable. */
	readonly penaltyPrefix: string | undefined;
	/** Escalation-strike namespace, including the observe-only segment when applicable. */
	readonly strikePrefix: string | undefined;
}

/** Internal hook used by `limit()` to bind refundable manual-consume results. */
export interface RuleRuntimeHooks<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
> {
	readonly onManualConsumed?: (
		ctx: C,
		result: LimiterConsumeResult<M>,
		refund: () => Promise<boolean>,
	) => void;
}

/** Internal middleware evaluation result when no public decision capture is needed. */
interface MiddlewareEvaluation {
	readonly isAllowed: boolean;
}

/** Emits a legacy bypass event only when the rule has listeners for it. */
function emitBypassed<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(
	rule: Rule<C, M>,
	ctx: C,
	info: LimiterBypassInfo,
): void {
	if (rule.events.hasListeners('bypassed')) {
		rule.events.emit('bypassed', ctx, info);
	}
}

/** Returns an isolated prefix for observe-only shadow state. */
function resolveRuntimePrefix<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(prefix: string, rule: Rule<C, M>): string {
	return rule.mode === 'observe' ? `${prefix}:${OBSERVE_KEY_SEGMENT}` : prefix;
}

/** Resolves and validates one optional penalty duration. */
function resolvePenaltyDuration<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(
	rule: Rule<C, M>,
	ctx: C,
	result: LimitResult,
): number | undefined {
	if (!rule.penalty) {
		return undefined;
	}

	const generated = rule.penalty.generator(ctx, result);

	if (!Number.isFinite(generated)) {
		throw new Error('Limiter: penalty duration generator must return a finite number.');
	}

	return generated > 0 ? Math.ceil(generated) : undefined;
}

/**
 * Creates one runtime evaluator shared by grammY middleware and manual
 * `consume()` calls.
 *
 * The evaluator deliberately supports a non-capturing path. Normal middleware
 * uses it so `withMetadata(resolver)` remains lazy when nobody observes the
 * structured `decision` event. Manual consumption captures the principal
 * decision and therefore resolves enabled metadata exactly once for that call.
 */
export function createRuleRuntime<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
>(rule: Rule<C, M>, hooks: RuleRuntimeHooks<C, M> = {}): {
	readonly namespaces: RuleRuntimeNamespaces;
	readonly evaluate: (ctx: C) => Promise<MiddlewareEvaluation>;
	readonly consume: (ctx: C) => Promise<LimiterConsumeResult<M>>;
} {
	if (
		rule.penalty?.escalation !== undefined &&
		rule.storage.applyEscalatingPenalty === undefined
	) {
		throw new Error(
			'Limiter: penalty escalation requires storage.applyEscalatingPenalty(). Built-in MemoryStore and RedisStore support it.',
		);
	}

	const storage = guardStorage(rule.storage);
	const metricsEnabled = rule.events.hasListeners('metric');
	const strategyPrefix = resolveRuntimePrefix(rule.keyPrefix, rule);
	const penaltyPrefix = rule.penalty === undefined
		? undefined
		: resolveRuntimePrefix(rule.penalty.keyPrefix, rule);
	const strikePrefix = rule.penalty?.escalation === undefined
		? undefined
		: resolveRuntimePrefix(rule.penalty.escalation.keyPrefix, rule);
	const namespaces: RuleRuntimeNamespaces = {
		strategyPrefix,
		penaltyPrefix,
		strikePrefix,
	};

	async function run(ctx: C, capture: false): Promise<MiddlewareEvaluation>;
	async function run(ctx: C, capture: true): Promise<LimiterConsumeResult<M>>;
	async function run(
		ctx: C,
		capture: boolean,
	): Promise<MiddlewareEvaluation | LimiterConsumeResult<M>> {
		let metadataResolved = false;
		let metadata: ReturnType<Rule<C, M>['resolveMetadata']>;
		const metricStartedAt = metricsEnabled ? performance.now() : undefined;
		const metricSource = capture ? 'manual-consume' as const : 'middleware' as const;

		const decorateDecision = (decision: LimiterDecision): LimiterDecision<M> => {
			if (!metadataResolved) {
				metadata = rule.resolveMetadata(ctx);
				metadataResolved = true;
			}

			return {
				...decision,
				...(rule.name === undefined ? {} : { ruleName: rule.name }),
				...(metadata === undefined ? {} : { metadata }),
			} as LimiterDecision<M>;
		};

		const reportDecision = (decision: LimiterDecision): void => {
			const hasDecisionListener = rule.events.hasListeners('decision');
			const hasMetricListener = metricStartedAt !== undefined;

			if (!hasDecisionListener && !hasMetricListener) {
				return;
			}

			const decorated = decorateDecision(decision);

			if (hasDecisionListener) {
				rule.events.emit('decision', ctx, decorated);
			}

			if (hasMetricListener) {
				rule.events.emit('metric', ctx, {
					kind: 'decision',
					source: metricSource,
					timestamp: Date.now(),
					durationMs: Math.max(0, performance.now() - metricStartedAt),
					decision: decorated,
				});
			}
		};

		const complete = (
			isAllowed: boolean,
			decision: LimiterDecision,
		): MiddlewareEvaluation | LimiterConsumeResult<M> => {
			if (!capture) {
				return { isAllowed };
			}

			return {
				...decorateDecision(decision),
				isAllowed,
			} as LimiterConsumeResult<M>;
		};

		const handleStorageFailure = async (
			phase: StorageFailurePhase,
			entityKey: string,
			error: StorageOperationError,
		): Promise<Exclude<StorageFailureMode, 'throw'>> => {
			const mode = await resolveStorageFailure(
				ctx,
				rule.events,
				rule.storageFailurePolicy,
				phase,
				entityKey,
				error,
			);

			if (mode === 'throw') {
				throw error.cause;
			}

			reportDecision({
				outcome: 'storage-failure',
				mode: rule.mode,
				entityKey,
				phase,
				operation: error.operation,
				key: error.key,
				resolution: mode,
				error: error.cause,
			});

			return mode;
		};

		const applies = await rule.filter(ctx);

		if (!applies) {
			const info: LimiterBypassInfo = { reason: 'filter' };
			const decision: LimiterDecision = {
				outcome: 'bypassed',
				mode: rule.mode,
				...info,
			};

			emitBypassed(rule, ctx, info);
			reportDecision(decision);

			return complete(true, decision);
		}

		const entityKey = rule.keyGenerator(ctx);

		if (entityKey === undefined) {
			const info: LimiterBypassInfo = { reason: 'missing-key' };
			const decision: LimiterDecision = {
				outcome: 'bypassed',
				mode: rule.mode,
				...info,
			};

			emitBypassed(rule, ctx, info);
			reportDecision(decision);

			return complete(true, decision);
		}

		const storageKey = `${strategyPrefix}:${entityKey}`;
		const strategy = rule.resolveStrategy(ctx);
		const penaltyKey = rule.penalty && penaltyPrefix
			? `${penaltyPrefix}:${entityKey}`
			: undefined;

		const reportPenaltyHit = (): MiddlewareEvaluation | LimiterConsumeResult<M> => {
			if (rule.events.hasListeners('penaltyHit')) {
				rule.events.emit('penaltyHit', ctx, entityKey);
			}

			const decision: LimiterDecision = {
				outcome: 'penalty-hit',
				mode: rule.mode,
				entityKey,
				penaltyKey: penaltyKey!,
			};

			reportDecision(decision);

			return complete(rule.mode === 'observe', decision);
		};

		const reportStrategyFailure = async (
			error: StorageOperationError,
		): Promise<MiddlewareEvaluation | LimiterConsumeResult<M>> => {
			const mode = await handleStorageFailure('strategy-check', entityKey, error);
			const info: LimiterBypassInfo = {
				reason: 'storage-failure',
				entityKey,
				phase: 'strategy-check',
			};

			if (mode === 'fail-open' || rule.mode === 'observe') {
				emitBypassed(rule, ctx, info);
			}

			const decision: LimiterDecision = {
				outcome: 'storage-failure',
				mode: rule.mode,
				entityKey,
				phase: 'strategy-check',
				operation: error.operation,
				key: error.key,
				resolution: mode,
				error: error.cause,
			};

			return complete(mode === 'fail-open' || rule.mode === 'observe', decision);
		};

		let result: LimitResult;

		// A configured penalty normally needs its own storage round trip before the
		// strategy runs. When the strategy and storage both support the atomic
		// primitive, the active-penalty check and the strategy consumption are
		// evaluated as one storage operation instead of two.
		if (
			penaltyKey !== undefined &&
			strategy.toAtomicOperation !== undefined &&
			storage.consumeAtomicLimit !== undefined
		) {
			let transaction: AtomicLimitConsumeResult;

			try {
				transaction = await storage.consumeAtomicLimit([{
					operation: strategy.toAtomicOperation(storageKey),
					penaltyKey,
				}]);
			} catch (error) {
				if (!(error instanceof StorageOperationError)) {
					throw error;
				}

				return await reportStrategyFailure(error);
			}

			if (transaction.outcome === 'penalty-hit') {
				return reportPenaltyHit();
			}

			result = transaction.results[0]!;
			strategy.adoptConsumption?.(result);
		} else {
			if (penaltyKey !== undefined) {
				let isPenalized: boolean;

				try {
					isPenalized = await storage.checkPenalty(penaltyKey);
				} catch (error) {
					if (!(error instanceof StorageOperationError)) {
						throw error;
					}

					const mode = await handleStorageFailure(
						'penalty-check',
						entityKey,
						error,
					);

					if (mode === 'fail-closed') {
						const info: LimiterBypassInfo = {
							reason: 'storage-failure',
							entityKey,
							phase: 'penalty-check',
						};

						if (rule.mode === 'observe') {
							emitBypassed(rule, ctx, info);
						}

						const decision: LimiterDecision = {
							outcome: 'storage-failure',
							mode: rule.mode,
							entityKey,
							phase: 'penalty-check',
							operation: error.operation,
							key: error.key,
							resolution: mode,
							error: error.cause,
						};

						return complete(rule.mode === 'observe', decision);
					}

					isPenalized = false;
				}

				if (isPenalized) {
					return reportPenaltyHit();
				}
			}

			try {
				result = await strategy.check(storageKey, storage);
			} catch (error) {
				if (!(error instanceof StorageOperationError)) {
					throw error;
				}

				return await reportStrategyFailure(error);
			}
		}

		if (result.isAllowed) {
			if (rule.events.hasListeners('allowed')) {
				rule.events.emit('allowed', ctx, result);
			}

			const decision: LimiterDecision = {
				outcome: 'allowed',
				mode: rule.mode,
				entityKey,
				storageKey,
				result,
			};

			reportDecision(decision);

			const completed = complete(true, decision);

			if (capture && hooks.onManualConsumed !== undefined) {
				const consumed = completed as LimiterConsumeResult<M>;

				hooks.onManualConsumed(
					ctx,
					consumed,
					async () =>
						strategy.refund === undefined
							? false
							: await strategy.refund(storageKey, rule.storage, result),
				);
			}

			return completed;
		}

		if (rule.events.hasListeners('throttled')) {
			rule.events.emit('throttled', ctx, result);
		}

		const throttledDecision: LimiterDecision = {
			outcome: 'throttled',
			mode: rule.mode,
			entityKey,
			storageKey,
			result,
		};

		reportDecision(throttledDecision);

		if (rule.mode === 'enforce') {
			await rule.onLimitExceeded(ctx, result, rule.storage);
		}

		const penaltyDuration = resolvePenaltyDuration(rule, ctx, result);

		if (penaltyDuration !== undefined && penaltyPrefix) {
			const penaltyKey = `${penaltyPrefix}:${entityKey}`;
			let appliedDuration = penaltyDuration;
			let appliedStrikes: number | undefined;

			try {
				if (rule.penalty?.escalation !== undefined && strikePrefix !== undefined) {
					const escalation = await storage.applyEscalatingPenalty!(
						penaltyKey,
						`${strikePrefix}:${entityKey}`,
						{
							basePenaltyTime: penaltyDuration,
							factor: rule.penalty.escalation.factor,
							maxPenaltyTime: rule.penalty.escalation.maxPenaltyTime,
							resetAfter: rule.penalty.escalation.resetAfter,
						},
					);

					appliedDuration = escalation.penaltyTime;
					appliedStrikes = escalation.strikes;
				} else {
					await storage.setPenalty(penaltyKey, penaltyDuration);
				}
			} catch (error) {
				if (!(error instanceof StorageOperationError)) {
					throw error;
				}

				await handleStorageFailure(
					'penalty-write',
					entityKey,
					error,
				);

				return complete(rule.mode === 'observe', throttledDecision);
			}

			// Penalty events describe enforcement state only. Observe-only shadow state
			// remains visible through inspection and decision telemetry.
			if (rule.mode === 'enforce' && rule.events.hasListeners('penaltyApplied')) {
				rule.events.emit('penaltyApplied', ctx, entityKey, appliedDuration);
			}

			if (
				rule.mode === 'enforce' &&
				appliedStrikes !== undefined &&
				rule.events.hasListeners('penaltyStrike')
			) {
				rule.events.emit('penaltyStrike', ctx, entityKey, appliedStrikes, appliedDuration);
			}
		}

		return complete(rule.mode === 'observe', throttledDecision);
	}

	return {
		namespaces,
		evaluate: (ctx: C) => run(ctx, false),
		consume: (ctx: C) => run(ctx, true),
	};
}
