import type { Rule } from './rule.ts';

import { Limiter } from './builder.ts';
import { createRuleRuntime } from './evaluator.ts';
import { diagnoseRule, inspectRule } from './diagnostics.ts';

import type {
	GrammyContext,
	LimiterConsumeResult,
	LimiterInspection,
	LimiterMetadataFields,
	LimiterMiddleware,
	NextFunction,
} from '../types.ts';

/**
 * Creates grammY middleware from a configured limiter.
 *
 * A `Limiter` builder is finalized once when this function is called. A pre-built
 * `Rule` may also be supplied directly. The returned function remains ordinary
 * grammY middleware while exposing manual execution and administrative controls
 * over the exact same immutable rule.
 *
 * Normal middleware execution and `consume()` share one internal evaluator.
 * Consequently filters, key generation, penalties, strategies, observe-only
 * behavior, storage-failure policies, events, `onThrottled()`, and escalation
 * cannot drift between automatic and manual use. `consume()` never calls grammY
 * `next()`; its `isAllowed` result tells the caller whether the configured
 * middleware would have continued downstream.
 *
 * Rich metadata remains lazy for normal middleware: a configured metadata
 * resolver runs only when a structured `decision` listener needs it. Manual
 * `consume()` resolves enabled metadata because it returns that structured
 * decision to the caller.
 *
 * @param ruleOrBuilder Configured builder or previously built read-only rule.
 * @returns A grammY 2-compatible middleware function with typed manual/state controls.
 */
export function limit<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
>(
	ruleOrBuilder: Rule<C, M> | Limiter<C, M>,
): LimiterMiddleware<C, M> {
	const rule = ruleOrBuilder instanceof Limiter ? ruleOrBuilder.build() : ruleOrBuilder;

	type ConsumeResult = LimiterConsumeResult<M>;

	interface RefundReceipt {
		readonly ctx: C;
		readonly refund: () => Promise<boolean>;
		inFlight?: Promise<boolean>;
	}

	const refunds = new WeakMap<ConsumeResult, RefundReceipt>();
	const metricsEnabled = rule.events.hasListeners('metric');
	const runtime = createRuleRuntime(rule, {
		onManualConsumed: (ctx, result, refund) => {
			refunds.set(result, { ctx, refund });
		},
	});
	const { strategyPrefix, penaltyPrefix, strikePrefix } = runtime.namespaces;

	const middleware = async (ctx: C, next: NextFunction): Promise<void> => {
		const result = await runtime.evaluate(ctx);

		if (result.isAllowed) {
			await next();
		}
	};

	const inspect = async (ctx: C): Promise<LimiterInspection<M>> =>
		(await inspectRule(rule, ctx, strategyPrefix, penaltyPrefix, strikePrefix)).inspection;

	const diagnose = (ctx: C) =>
		diagnoseRule(rule, ctx, strategyPrefix, penaltyPrefix, strikePrefix);

	const reset = async (ctx: C): Promise<boolean> => {
		const entityKey = rule.keyGenerator(ctx);

		if (entityKey === undefined) {
			return false;
		}

		return await rule.resetStrategy(`${strategyPrefix}:${entityKey}`);
	};

	const clearPenalty = async (ctx: C): Promise<boolean> => {
		if (!rule.penalty || !penaltyPrefix) {
			return false;
		}

		const entityKey = rule.keyGenerator(ctx);

		if (entityKey === undefined) {
			return false;
		}

		await rule.storage.delete(`${penaltyPrefix}:${entityKey}`);

		return true;
	};

	const clearStrikes = async (ctx: C): Promise<boolean> => {
		if (rule.penalty?.escalation === undefined || strikePrefix === undefined) {
			return false;
		}

		const entityKey = rule.keyGenerator(ctx);

		if (entityKey === undefined) {
			return false;
		}

		await rule.storage.delete(`${strikePrefix}:${entityKey}`);

		return true;
	};

	const emitRefundMetric = (
		receipt: RefundReceipt,
		result: ConsumeResult,
		source: 'refund' | 'refund-best-effort',
		startedAt: number | undefined,
		outcome: 'succeeded' | 'unsupported' | 'failed',
		error?: unknown,
	): void => {
		if (startedAt === undefined) {
			return;
		}

		rule.events.emit('metric', receipt.ctx, {
			kind: 'refund',
			source,
			timestamp: Date.now(),
			durationMs: Math.max(0, performance.now() - startedAt),
			outcome,
			result,
			...(error === undefined ? {} : { error }),
		});
	};

	const performRefund = async (
		result: ConsumeResult,
		source: 'refund' | 'refund-best-effort',
	): Promise<boolean> => {
		const receipt = refunds.get(result);

		if (receipt === undefined) {
			return false;
		}

		if (receipt.inFlight !== undefined) {
			return await receipt.inFlight;
		}

		const metricStartedAt = metricsEnabled ? performance.now() : undefined;
		const operation = (async (): Promise<boolean> => {
			let supported: boolean;

			try {
				supported = await receipt.refund();
			} catch (error) {
				receipt.inFlight = undefined;
				emitRefundMetric(receipt, result, source, metricStartedAt, 'failed', error);

				throw error;
			}

			refunds.delete(result);
			emitRefundMetric(
				receipt,
				result,
				source,
				metricStartedAt,
				supported ? 'succeeded' : 'unsupported',
			);

			return supported;
		})();

		receipt.inFlight = operation;

		return await operation;
	};

	const refund = (result: ConsumeResult): Promise<boolean> => performRefund(result, 'refund');

	const refundBestEffort = (result: ConsumeResult): boolean => {
		const receipt = refunds.get(result);

		if (receipt === undefined) {
			return false;
		}

		void performRefund(result, 'refund-best-effort').catch((error) => {
			if (!rule.events.hasListeners('refundError')) {
				return;
			}

			try {
				rule.events.emit('refundError', receipt.ctx, result, error);
			} catch {
				// Detached best-effort work must never create an uncaught exception.
			}
		});

		return true;
	};

	return Object.assign(middleware, {
		consume: runtime.consume,
		diagnose,
		refund,
		refundBestEffort,
		inspect,
		reset,
		clearPenalty,
		clearStrikes,
	});
}
