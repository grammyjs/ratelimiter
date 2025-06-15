import { FixedWindowStrategy } from '../strategies/fixed_window.ts';
import type { GrammyContext, NextFunction } from '../types.ts';
import { Limiter } from './builder.ts';
import type { Rule } from './rule.ts';

/**
 * The main middleware function generator.
 *
 * It accepts either a pre-built `Rule` object or a `Limiter` builder instance.
 *
 * @param ruleOrBuilder An instance of a `Rule` or a `Limiter` builder.
 * @returns A grammY-compatible middleware function.
 */
export function limit<C extends GrammyContext>(ruleOrBuilder: Rule<C> | Limiter<C>): (ctx: C, next: NextFunction) => Promise<void> {
	const rule = ruleOrBuilder instanceof Limiter ? ruleOrBuilder.build() : ruleOrBuilder;

	return async (ctx: C, next: NextFunction): Promise<void> => {
		if (rule.penalty) {
			const baseKey = rule.keyGenerator(ctx);

			if (baseKey) {
				const penaltyKey = `${rule.penalty.keyPrefix}:${baseKey}`;
				const isPenalized = await rule.storage.checkPenalty(penaltyKey);

				if (isPenalized) {
					return;
				}
			}
		}

		const applies = await rule.filter(ctx);
		if (!applies) {
			return await next();
		}

		const entityKey = rule.keyGenerator(ctx);
		if (entityKey === undefined) {
			return await next();
		}

		const storageKey = `${rule.keyPrefix}:${entityKey}`;

		let strategy = rule.strategy;
		if (rule.dynamicLimitGenerator && rule.strategy instanceof FixedWindowStrategy) {
			const newLimit = rule.dynamicLimitGenerator(ctx);

			strategy = new FixedWindowStrategy({
				...rule.strategy.options,
				limit: newLimit,
			});
		}

		const result = await strategy.check(storageKey, rule.storage);

		if (result.isAllowed) {
			if (rule.events.hasListeners('allowed')) {
				rule.events.emit('allowed', ctx, result);
			}

			await next();
		} else {
			if (rule.events.hasListeners('throttled')) {
				rule.events.emit('throttled', ctx, result);
			}

			await rule.onLimitExceeded(ctx, result, rule.storage);

			if (rule.penalty) {
				const penaltyDuration = rule.penalty.generator(ctx, result);

				if (penaltyDuration > 0) {
					const penaltyKey = `${rule.penalty.keyPrefix}:${entityKey}`;
					await rule.storage.setPenalty(penaltyKey, penaltyDuration);

					if (rule.events.hasListeners('penaltyApplied')) {
						rule.events.emit('penaltyApplied', ctx, entityKey, penaltyDuration);
					}
				}
			}
		}
	};
}
