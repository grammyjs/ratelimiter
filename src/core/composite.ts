import type { Rule } from './rule.ts';
import type { Limiter } from './builder.ts';

import { limit } from './middleware.ts';

import type {
	GrammyContext,
	LimiterCompositeDiagnostic,
	LimiterCompositeMiddleware,
	LimiterMetadataFields,
	NextFunction,
} from '../types.ts';

/** A builder or already-built rule that can participate in a limiter chain. */
export type LimitLayer<C extends GrammyContext> =
	| Limiter<C, LimiterMetadataFields | undefined>
	| Rule<C, LimiterMetadataFields | undefined>;

/**
 * Composes one or more limiter rules into a single grammY middleware function.
 *
 * Every layer must allow or bypass the update before downstream middleware is
 * called. Layers are evaluated from left to right and short-circuit on the
 * first layer that throttles, hits an active penalty, or resolves a storage
 * failure as fail-closed.
 *
 * Each `Limiter` builder is finalized exactly once when `limitAll()` is called,
 * so later builder changes do not affect the composed middleware.
 *
 * Capacity consumed by an earlier layer is not rolled back if a later layer
 * rejects the same update. This is intentional: layers may use independent or
 * distributed storage engines, so cross-layer rollback could not be guaranteed
 * atomically. Put more selective limits earlier when rejected updates should
 * avoid consuming capacity from broader limits.
 *
 * @example User and global limits sharing one storage engine.
 * ```ts
 * bot.use(limitAll(
 *   new Limiter<Context>()
 *     .useStorage(storage)
 *     .fixedWindow({ limit: 10, timeFrame: 60_000 })
 *     .limitFor('user')
 *     .withKeyPrefix('messages:user'),
 *   new Limiter<Context>()
 *     .useStorage(storage)
 *     .fixedWindow({ limit: 1_000, timeFrame: 60_000 })
 *     .limitFor('global')
 *     .withKeyPrefix('messages:global'),
 * ));
 * ```
 *
 * @param first First limiter layer. At least one layer is required.
 * @param rest Additional layers evaluated after the first.
 * @returns One grammY middleware function representing the complete chain.
 */
export function limitAll<C extends GrammyContext>(
	first: LimitLayer<C>,
	...rest: LimitLayer<C>[]
): LimiterCompositeMiddleware<C> {
	const middlewares = [first, ...rest].map((layer) => limit(layer));

	const middleware = async (ctx: C, next: NextFunction): Promise<void> => {
		let index = 0;

		const dispatch = async (): Promise<void> => {
			const middleware = middlewares[index];

			index += 1;

			if (!middleware) {
				await next();

				return;
			}

			await middleware(ctx, dispatch);
		};

		await dispatch();
	};

	const diagnose = async (ctx: C): Promise<LimiterCompositeDiagnostic> => {
		const layers: Array<LimiterCompositeDiagnostic['layers'][number]> = [];

		for (let index = 0; index < middlewares.length; index += 1) {
			const diagnostic = await middlewares[index]!.diagnose(ctx);

			layers.push({ index, diagnostic });

			if (diagnostic.wouldContinue === false) {
				return { mode: 'sequential', outcome: 'would-block', blockingLayer: index, layers };
			}

			if (diagnostic.wouldContinue === undefined) {
				return { mode: 'sequential', outcome: 'unknown', uncertainLayer: index, layers };
			}
		}

		return { mode: 'sequential', outcome: 'would-continue', layers };
	};

	return Object.assign(middleware, { diagnose });
}
