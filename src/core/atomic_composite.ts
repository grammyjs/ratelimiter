import type { Rule } from './rule.ts';
import type { LimitLayer } from './composite.ts';
import type { MiddlewareFn } from '@grammyjs/grammy';

import { Limiter } from './builder.ts';
import { limit } from './middleware.ts';
import { resolveStorageFailure } from './storage_failure.ts';
import { guardStorage, StorageOperationError } from './storage_guard.ts';

import type {
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	GrammyContext,
	LimiterBypassInfo,
	LimiterCompositeDiagnostic,
	LimiterCompositeMiddleware,
	LimiterDecision,
	LimiterMetadataFields,
	LimitResult,
	StorageFailureMode,
} from '../types.ts';

interface ResolvedAtomicLayer<C extends GrammyContext> {
	readonly rule: Rule<C, LimiterMetadataFields | undefined>;
	readonly entityKey: string;
	readonly storageKey: string;
	readonly penaltyKey?: string;
	readonly input: AtomicLimitLayerInput;
}

/** Emits a legacy bypass event only when the rule has listeners for it. */
function emitBypassed<C extends GrammyContext>(
	rule: Rule<C, LimiterMetadataFields | undefined>,
	ctx: C,
	info: LimiterBypassInfo,
): void {
	if (rule.events.hasListeners('bypassed')) {
		rule.events.emit('bypassed', ctx, info);
	}
}

/** Emits one structured decision record only when it is observed. */
function emitDecision<C extends GrammyContext>(
	rule: Rule<C, LimiterMetadataFields | undefined>,
	ctx: C,
	decision: LimiterDecision,
	metricStartedAt?: number,
): void {
	const hasDecisionListener = rule.events.hasListeners('decision');
	const hasMetricListener = metricStartedAt !== undefined && rule.events.hasListeners('metric');

	if (!hasDecisionListener && !hasMetricListener) {
		return;
	}

	const metadata = rule.resolveMetadata(ctx);
	const decorated = {
		...decision,
		...(rule.name === undefined ? {} : { ruleName: rule.name }),
		...(metadata === undefined ? {} : { metadata }),
	} as LimiterDecision<LimiterMetadataFields | undefined>;

	if (hasDecisionListener) {
		rule.events.emit('decision', ctx, decorated);
	}

	if (hasMetricListener) {
		rule.events.emit('metric', ctx, {
			kind: 'decision',
			source: 'atomic-composite',
			timestamp: Date.now(),
			durationMs: Math.max(0, performance.now() - metricStartedAt),
			decision: decorated,
		});
	}
}

/** Resolves and validates one optional penalty duration. */
function resolvePenaltyDuration<C extends GrammyContext>(
	rule: Rule<C, LimiterMetadataFields | undefined>,
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
 * Applies a penalty after the one strategy that rejected an atomic chain.
 *
 * The transaction itself intentionally does not create penalties because a
 * dynamic penalty generator and `onThrottled()` may execute application code.
 * Keeping those side effects outside the storage transaction preserves the same
 * ordering and failure semantics as `limit()`.
 */
async function applyRejectedPenalty<C extends GrammyContext>(
	layer: ResolvedAtomicLayer<C>,
	ctx: C,
	result: LimitResult,
): Promise<void> {
	const { rule, entityKey, penaltyKey } = layer;
	const penaltyDuration = resolvePenaltyDuration(rule, ctx, result);

	if (penaltyDuration === undefined || penaltyKey === undefined || rule.penalty === undefined) {
		return;
	}

	const storage = guardStorage(rule.storage);
	let appliedDuration = penaltyDuration;
	let appliedStrikes: number | undefined;

	try {
		if (rule.penalty.escalation !== undefined) {
			const escalation = await storage.applyEscalatingPenalty!(
				penaltyKey,
				`${rule.penalty.escalation.keyPrefix}:${entityKey}`,
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

		const mode = await resolveStorageFailure(
			ctx,
			rule.events,
			rule.storageFailurePolicy,
			'penalty-write',
			entityKey,
			error,
		);

		if (mode === 'throw') {
			throw error.cause;
		}

		return;
	}

	if (rule.events.hasListeners('penaltyApplied')) {
		rule.events.emit('penaltyApplied', ctx, entityKey, appliedDuration);
	}

	if (appliedStrikes !== undefined && rule.events.hasListeners('penaltyStrike')) {
		rule.events.emit('penaltyStrike', ctx, entityKey, appliedStrikes, appliedDuration);
	}
}

/**
 * Resolves a failed atomic storage transaction across all participating rules.
 *
 * Each rule receives its own `storageError` event and policy resolution. `throw`
 * wins immediately; otherwise `fail-closed` wins over `fail-open`. This gives a
 * chain deterministic availability semantics even when its layers use different
 * failure policies.
 */
async function handleAtomicStorageFailure<C extends GrammyContext>(
	layers: readonly ResolvedAtomicLayer<C>[],
	ctx: C,
	error: unknown,
	metricStartedAt?: number,
): Promise<Exclude<StorageFailureMode, 'throw'>> {
	let aggregate: Exclude<StorageFailureMode, 'throw'> = 'fail-open';

	for (const layer of layers) {
		const tagged = new StorageOperationError(
			'consumeAtomicLimit',
			layer.storageKey,
			error,
		);
		const mode = await resolveStorageFailure(
			ctx,
			layer.rule.events,
			layer.rule.storageFailurePolicy,
			'composite-check',
			layer.entityKey,
			tagged,
		);

		if (mode === 'throw') {
			throw error;
		}

		if (mode === 'fail-closed') {
			aggregate = 'fail-closed';
		}

		emitDecision(layer.rule, ctx, {
			outcome: 'storage-failure',
			mode: layer.rule.mode,
			entityKey: layer.entityKey,
			phase: 'composite-check',
			operation: 'consumeAtomicLimit',
			key: layer.storageKey,
			resolution: mode,
			error,
		}, metricStartedAt);
	}

	return aggregate;
}

/** Returns one validated, snapshotted rule for a composite layer. */
function buildLayer<C extends GrammyContext>(
	layer: LimitLayer<C>,
): Rule<C, LimiterMetadataFields | undefined> {
	return layer instanceof Limiter ? layer.build() : layer;
}

/**
 * Composes limiter rules with all-or-nothing strategy capacity consumption.
 *
 * This is the atomic counterpart to `limitAll()`. The existing `limitAll()` API
 * intentionally keeps its sequential semantics for backwards compatibility;
 * `limitAllAtomic()` is explicit because it has stronger storage requirements.
 *
 * All rules must use the exact same storage instance and must run in enforcement
 * mode. The storage must implement `consumeAtomicLimit()`. Built-in `MemoryStore`
 * and `RedisStore` do. Built-in strategies participate automatically; a custom
 * strategy may opt in by implementing `ILimiterStrategy.toAtomicOperation()`.
 *
 * Filters and missing entity keys bypass their layer before the transaction. For
 * all active layers, penalty checks and strategy decisions happen atomically. If
 * any active penalty or strategy rejects the update, **no strategy capacity is
 * consumed by any layer**. When every layer allows, every strategy state change
 * is committed together before downstream middleware runs.
 *
 * Only the rejecting rule receives `throttled`/`penaltyHit` events. Earlier
 * provisional allows are deliberately not emitted as `allowed`, because their
 * capacity was never committed. On successful transactions, `allowed` and
 * `decision` events are emitted for every active layer in left-to-right order.
 *
 * Redis Cluster can execute a multi-key Lua transaction only when every key is
 * in one hash slot. Use a shared hash tag in all participating prefixes, such as
 * `{my-bot}:user` and `{my-bot}:global`.
 *
 * @example Atomically combine user and global limits.
 * ```ts
 * bot.use(limitAllAtomic(
 *   new Limiter<Context>()
 *     .useStorage(storage)
 *     .fixedWindow({ limit: 10, timeFrame: 60_000 })
 *     .limitFor('user')
 *     .withKeyPrefix('{my-bot}:messages:user'),
 *   new Limiter<Context>()
 *     .useStorage(storage)
 *     .tokenBucket({ bucketSize: 1_000, tokensPerInterval: 1_000, interval: 60_000 })
 *     .limitFor('global')
 *     .withKeyPrefix('{my-bot}:messages:global'),
 * ));
 * ```
 *
 * @param first First atomic limiter layer. At least one layer is required.
 * @param rest Additional layers evaluated after the first.
 * @returns One grammY middleware function representing the atomic chain.
 * @throws When layers use different stores, observe-only mode, an unsupported
 * strategy, duplicate strategy keys, or storage without atomic-composite support.
 */
export function limitAllAtomic<C extends GrammyContext>(
	first: LimitLayer<C>,
	...rest: LimitLayer<C>[]
): LimiterCompositeMiddleware<C> {
	const rules = [first, ...rest].map(buildLayer);
	const storage = rules[0]!.storage;

	const consumeAtomicLimit = storage.consumeAtomicLimit?.bind(storage);

	if (consumeAtomicLimit === undefined) {
		throw new Error(
			'Limiter: limitAllAtomic() requires storage.consumeAtomicLimit(). Built-in MemoryStore and RedisStore support it.',
		);
	}

	for (const rule of rules) {
		if (rule.storage !== storage) {
			throw new Error(
				'Limiter: limitAllAtomic() requires every layer to share the exact same storage instance.',
			);
		}

		if (rule.mode !== 'enforce') {
			throw new Error(
				'Limiter: observe-only rules cannot participate in limitAllAtomic(); compose them separately with limitAll().',
			);
		}

		if (
			rule.penalty?.escalation !== undefined &&
			rule.storage.applyEscalatingPenalty === undefined
		) {
			throw new Error(
				'Limiter: penalty escalation requires storage.applyEscalatingPenalty(). Built-in MemoryStore and RedisStore support it.',
			);
		}
	}

	const metricsEnabled = rules.some((rule) => rule.events.hasListeners('metric'));
	const middleware: MiddlewareFn<C> = async (ctx, next): Promise<void> => {
		const metricStartedAt = metricsEnabled ? performance.now() : undefined;
		const active: ResolvedAtomicLayer<C>[] = [];

		for (const rule of rules) {
			const applies = await rule.filter(ctx);

			if (!applies) {
				const info: LimiterBypassInfo = { reason: 'filter' };

				emitBypassed(rule, ctx, info);
				emitDecision(
					rule,
					ctx,
					{ outcome: 'bypassed', mode: rule.mode, ...info },
					metricStartedAt,
				);

				continue;
			}

			const entityKey = rule.keyGenerator(ctx);

			if (entityKey === undefined) {
				const info: LimiterBypassInfo = { reason: 'missing-key' };

				emitBypassed(rule, ctx, info);
				emitDecision(
					rule,
					ctx,
					{ outcome: 'bypassed', mode: rule.mode, ...info },
					metricStartedAt,
				);

				continue;
			}

			const storageKey = `${rule.keyPrefix}:${entityKey}`;
			const strategy = rule.resolveStrategy(ctx);

			if (strategy.toAtomicOperation === undefined) {
				throw new Error(
					'Limiter: a strategy in limitAllAtomic() does not expose toAtomicOperation(). Use a built-in strategy or an atomic-compatible custom strategy.',
				);
			}

			const operation = strategy.toAtomicOperation(storageKey);
			const penaltyKey = rule.penalty === undefined
				? undefined
				: `${rule.penalty.keyPrefix}:${entityKey}`;

			active.push({
				rule,
				entityKey,
				storageKey,
				penaltyKey,
				input: { operation, ...(penaltyKey === undefined ? {} : { penaltyKey }) },
			});
		}

		if (active.length === 0) {
			await next();

			return;
		}

		const strategyKeys = new Set<string>();
		const penaltyKeys = new Set(
			active.flatMap((layer) => layer.penaltyKey === undefined ? [] : [layer.penaltyKey]),
		);

		for (const layer of active) {
			if (strategyKeys.has(layer.storageKey)) {
				throw new Error(
					`Limiter: limitAllAtomic() resolved duplicate strategy key '${layer.storageKey}'. Give every layer a distinct key prefix.`,
				);
			}

			if (penaltyKeys.has(layer.storageKey)) {
				throw new Error(
					`Limiter: limitAllAtomic() cannot use strategy key '${layer.storageKey}' as a penalty key. Use distinct strategy and penalty prefixes.`,
				);
			}

			strategyKeys.add(layer.storageKey);
		}

		let transaction: AtomicLimitConsumeResult;

		try {
			transaction = await consumeAtomicLimit(active.map((layer) => layer.input));
		} catch (error) {
			const mode = await handleAtomicStorageFailure(active, ctx, error, metricStartedAt);

			if (mode === 'fail-open') {
				for (const layer of active) {
					const info: LimiterBypassInfo = {
						reason: 'storage-failure',
						entityKey: layer.entityKey,
						phase: 'composite-check',
					};

					emitBypassed(layer.rule, ctx, info);
				}

				await next();
			}

			return;
		}

		if (transaction.outcome === 'allowed') {
			if (transaction.results.length !== active.length) {
				throw new Error('Limiter: atomic storage returned an incomplete allowed result.');
			}

			for (let index = 0; index < active.length; index += 1) {
				const layer = active[index]!;
				const result = transaction.results[index]!;

				if (layer.rule.events.hasListeners('allowed')) {
					layer.rule.events.emit('allowed', ctx, result);
				}

				emitDecision(layer.rule, ctx, {
					outcome: 'allowed',
					mode: layer.rule.mode,
					entityKey: layer.entityKey,
					storageKey: layer.storageKey,
					result,
				}, metricStartedAt);
			}

			await next();

			return;
		}

		const rejected = active[transaction.index];

		if (rejected === undefined) {
			throw new Error('Limiter: atomic storage returned an invalid rejection index.');
		}

		if (transaction.outcome === 'penalty-hit') {
			if (rejected.penaltyKey === undefined) {
				throw new Error(
					'Limiter: atomic storage reported a penalty hit for a layer without a penalty.',
				);
			}

			if (rejected.rule.events.hasListeners('penaltyHit')) {
				rejected.rule.events.emit('penaltyHit', ctx, rejected.entityKey);
			}

			emitDecision(rejected.rule, ctx, {
				outcome: 'penalty-hit',
				mode: rejected.rule.mode,
				entityKey: rejected.entityKey,
				penaltyKey: rejected.penaltyKey,
			}, metricStartedAt);

			return;
		}

		const result = transaction.results[transaction.index];

		if (result === undefined || result.isAllowed) {
			throw new Error('Limiter: atomic storage returned invalid throttling metadata.');
		}

		if (rejected.rule.events.hasListeners('throttled')) {
			rejected.rule.events.emit('throttled', ctx, result);
		}

		emitDecision(rejected.rule, ctx, {
			outcome: 'throttled',
			mode: rejected.rule.mode,
			entityKey: rejected.entityKey,
			storageKey: rejected.storageKey,
			result,
		}, metricStartedAt);
		await rejected.rule.onLimitExceeded(ctx, result, rejected.rule.storage);
		await applyRejectedPenalty(rejected, ctx, result);
	};

	const diagnosticMiddlewares = rules.map((rule) => limit(rule));
	const diagnose = async (ctx: C): Promise<LimiterCompositeDiagnostic> => {
		const layers: Array<LimiterCompositeDiagnostic['layers'][number]> = [];
		let uncertainLayer: number | undefined;

		for (let index = 0; index < diagnosticMiddlewares.length; index += 1) {
			const diagnostic = await diagnosticMiddlewares[index]!.diagnose(ctx);

			layers.push({ index, diagnostic });

			if (diagnostic.wouldContinue === false) {
				return { mode: 'atomic', outcome: 'would-block', blockingLayer: index, layers };
			}

			if (diagnostic.wouldContinue === undefined && uncertainLayer === undefined) {
				uncertainLayer = index;
			}
		}

		return uncertainLayer === undefined
			? { mode: 'atomic', outcome: 'would-continue', layers }
			: { mode: 'atomic', outcome: 'unknown', uncertainLayer, layers };
	};

	return Object.assign(middleware, { diagnose });
}
