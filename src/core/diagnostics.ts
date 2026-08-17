import type { Rule } from './rule.ts';

import type {
	GrammyContext,
	ILimiterStrategy,
	LimiterDiagnostic,
	LimiterInspection,
	LimiterMetadataFields,
	LimiterPenaltyEscalationInspection,
	LimiterPenaltyInspection,
	LimiterStorageFailurePolicyDiagnostic,
} from '../types.ts';

/** @internal Snapshot shared by `inspect()` and `diagnose()`. */
export interface RuleInspectionSnapshot<
	M extends LimiterMetadataFields | undefined,
> {
	readonly inspection: LimiterInspection<M>;
	readonly strategy?: ILimiterStrategy;
}

/** @internal Describes a rule's configured failure policy without invoking a resolver. */
function describeStorageFailurePolicy<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(rule: Rule<C, M>): LimiterStorageFailurePolicyDiagnostic {
	return typeof rule.storageFailurePolicy === 'function'
		? { kind: 'dynamic' }
		: { kind: 'static', mode: rule.storageFailurePolicy };
}

/**
 * @internal Reads the same non-consuming state used by public inspection and diagnostics.
 *
 * This helper deliberately does not run storage-failure policy resolvers or emit events.
 * Administrative storage/read failures therefore propagate to the caller exactly as they
 * do from `inspect()`.
 */
export async function inspectRule<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(
	rule: Rule<C, M>,
	ctx: C,
	strategyPrefix: string,
	penaltyPrefix: string | undefined,
	strikePrefix: string | undefined,
): Promise<RuleInspectionSnapshot<M>> {
	const metadata = rule.resolveMetadata(ctx);
	const identity = {
		...(rule.name === undefined ? {} : { ruleName: rule.name }),
		...(metadata === undefined ? {} : { metadata }),
	};
	const applies = await rule.filter(ctx);

	if (!applies) {
		return {
			inspection: {
				outcome: 'bypassed',
				...identity,
				mode: rule.mode,
				reason: 'filter',
			} as LimiterInspection<M>,
		};
	}

	const entityKey = rule.keyGenerator(ctx);

	if (entityKey === undefined) {
		return {
			inspection: {
				outcome: 'bypassed',
				...identity,
				mode: rule.mode,
				reason: 'missing-key',
			} as LimiterInspection<M>,
		};
	}

	const storageKey = `${strategyPrefix}:${entityKey}`;
	let penalty: LimiterPenaltyInspection = { configured: false };

	if (rule.penalty && penaltyPrefix) {
		const penaltyKey = `${penaltyPrefix}:${entityKey}`;
		let active: boolean;
		let expiresIn: number | undefined;

		if (rule.storage.getPenaltyTtl) {
			expiresIn = await rule.storage.getPenaltyTtl(penaltyKey);
			active = expiresIn !== undefined;
		} else {
			active = await rule.storage.checkPenalty(penaltyKey);
		}

		let escalation: LimiterPenaltyEscalationInspection = { configured: false };

		if (rule.penalty.escalation !== undefined && strikePrefix !== undefined) {
			const strikeKey = `${strikePrefix}:${entityKey}`;

			if (rule.storage.getPenaltyStrikeState === undefined) {
				escalation = { configured: true, supported: false, key: strikeKey };
			} else {
				const state = await rule.storage.getPenaltyStrikeState(strikeKey);

				escalation = {
					configured: true,
					supported: true,
					key: strikeKey,
					strikes: state?.strikes ?? 0,
					lastPenaltyTime: state?.lastPenaltyTime,
					resetsIn: state?.reset,
				};
			}
		}

		penalty = { configured: true, key: penaltyKey, active, expiresIn, escalation };
	}

	const strategy = rule.resolveStrategy(ctx);
	const preview = strategy.preview === undefined
		? undefined
		: await strategy.preview(storageKey, rule.storage);

	return {
		strategy,
		inspection: {
			outcome: 'ready',
			...identity,
			mode: rule.mode,
			entityKey,
			storageKey,
			penalty,
			strategy: preview === undefined
				? { supported: false }
				: { supported: true, result: preview },
		} as LimiterInspection<M>,
	};
}

/** @internal Converts one inspection snapshot into a richer developer diagnostic. */
export async function diagnoseRule<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined,
>(
	rule: Rule<C, M>,
	ctx: C,
	strategyPrefix: string,
	penaltyPrefix: string | undefined,
	strikePrefix: string | undefined,
): Promise<LimiterDiagnostic<M>> {
	const snapshot = await inspectRule(rule, ctx, strategyPrefix, penaltyPrefix, strikePrefix);
	const inspection = snapshot.inspection;
	const storageFailurePolicy = describeStorageFailurePolicy(rule);

	if (inspection.outcome === 'bypassed') {
		return {
			...inspection,
			wouldContinue: true,
			storageFailurePolicy,
		} as LimiterDiagnostic<M>;
	}

	if (inspection.penalty.configured && inspection.penalty.active) {
		return {
			outcome: 'penalty-hit',
			...(inspection.ruleName === undefined ? {} : { ruleName: inspection.ruleName }),
			...('metadata' in inspection ? { metadata: inspection.metadata } : {}),
			mode: inspection.mode,
			wouldContinue: inspection.mode === 'observe',
			entityKey: inspection.entityKey,
			storageKey: inspection.storageKey,
			penalty: inspection.penalty,
			strategyKind: rule.strategyKind,
			storageFailurePolicy,
		} as LimiterDiagnostic<M>;
	}

	const options = snapshot.strategy?.options === undefined
		? undefined
		: Object.freeze({ ...snapshot.strategy.options });

	if (!inspection.strategy.supported) {
		return {
			outcome: 'unknown',
			...(inspection.ruleName === undefined ? {} : { ruleName: inspection.ruleName }),
			...('metadata' in inspection ? { metadata: inspection.metadata } : {}),
			mode: inspection.mode,
			wouldContinue: undefined,
			reason: 'strategy-preview-unsupported',
			entityKey: inspection.entityKey,
			storageKey: inspection.storageKey,
			penalty: inspection.penalty,
			strategy: {
				kind: rule.strategyKind,
				...(options === undefined ? {} : { options }),
				previewSupported: false,
			},
			storageFailurePolicy,
		} as LimiterDiagnostic<M>;
	}

	const result = inspection.strategy.result;

	return {
		outcome: result.isAllowed ? 'would-allow' : 'would-throttle',
		...(inspection.ruleName === undefined ? {} : { ruleName: inspection.ruleName }),
		...('metadata' in inspection ? { metadata: inspection.metadata } : {}),
		mode: inspection.mode,
		wouldContinue: result.isAllowed || inspection.mode === 'observe',
		entityKey: inspection.entityKey,
		storageKey: inspection.storageKey,
		penalty: inspection.penalty,
		strategy: {
			kind: rule.strategyKind,
			...(options === undefined ? {} : { options }),
			previewSupported: true,
			result,
		},
		storageFailurePolicy,
	} as LimiterDiagnostic<M>;
}
