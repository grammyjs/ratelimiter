import type { Limiter } from './builder.ts';
import type { GrammyContext, LimiterMetadataFields } from '../types.ts';

/**
 * Factory used by {@link defineLimiterPreset} to construct one configured limiter builder.
 *
 * The factory is invoked for every {@link LimiterPreset.apply} call and must return a
 * fresh `Limiter` instance. Returning the same mutable builder more than once is rejected
 * at runtime so event listeners, names, metadata configuration, and later builder edits
 * cannot leak between preset consumers.
 */
export type LimiterPresetFactory<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
> = () => Limiter<C, M>;

/**
 * Immutable reusable recipe for constructing limiter builders.
 *
 * Presets capture configuration code rather than a built rule. Calling {@link apply}
 * reruns that recipe and returns a fresh fluent `Limiter`, which may then be customized
 * further before it is passed to `limit()`, `limitAll()`, or `limitAllAtomic()`.
 *
 * @example Reuse one anti-spam policy with independent rule names.
 * ```ts
 * const antiSpam = defineLimiterPreset(() =>
 *   Limiter.perUser<Context>()
 *     .useStorage(storage)
 *     .fixedWindow({ limit: 5, timeFrame: 10_000 })
 *     .withPenalty({ penaltyTime: 30_000 })
 * );
 *
 * bot.use(limit(antiSpam.apply().withName('messages')));
 * bot.command('search', limit(antiSpam.apply().withName('search')));
 * ```
 *
 * The preset itself contains no limiter state and does not build middleware eagerly.
 * Storage instances intentionally remain whatever the factory captures, allowing a
 * shared `MemoryStore` or `RedisStore` to be reused with distinct key prefixes.
 */
export class LimiterPreset<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
> {
	readonly #factory: LimiterPresetFactory<C, M>;
	readonly #issuedBuilders = new WeakSet<Limiter<C, M>>();

	/**
	 * Creates a reusable preset from a limiter factory.
	 *
	 * Prefer {@link defineLimiterPreset} for clearer inference at call sites.
	 *
	 * @param factory Factory that returns one fresh configured limiter builder per call.
	 */
	public constructor(factory: LimiterPresetFactory<C, M>) {
		this.#factory = factory;
	}

	/**
	 * Creates a fresh limiter builder from this preset.
	 *
	 * The returned builder is fully mutable and may be extended with names, metadata,
	 * predicates, penalties, handlers, or any other normal `Limiter` configuration.
	 * Changes made to one applied builder never mutate the preset or another application.
	 *
	 * @returns A newly configured limiter builder with the preset's context/metadata types.
	 * @throws If the factory returns the same mutable builder instance more than once.
	 */
	public apply(): Limiter<C, M> {
		const limiter = this.#factory();

		if (this.#issuedBuilders.has(limiter)) {
			throw new Error(
				'LimiterPreset: preset factory must return a fresh Limiter builder for every apply().',
			);
		}

		this.#issuedBuilders.add(limiter);

		return limiter;
	}
}

/**
 * Defines a reusable, strongly typed limiter configuration.
 *
 * TypeScript infers both the grammY context type and optional rich-metadata type from
 * the factory's returned builder. The factory is deliberately explicit instead of a
 * configuration object so every current and future fluent-builder feature remains
 * available without duplicating the limiter API surface.
 *
 * @param factory Function that constructs one fresh configured `Limiter` per invocation.
 * @returns An immutable preset whose {@link LimiterPreset.apply} method creates builders.
 */
export function defineLimiterPreset<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
>(factory: LimiterPresetFactory<C, M>): LimiterPreset<C, M> {
	return new LimiterPreset(factory);
}
