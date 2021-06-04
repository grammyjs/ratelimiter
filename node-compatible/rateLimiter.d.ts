import { Context, NextFunction, OptionsInterface, RedisType } from "./Types&Defaults.js";
/**
 *
 * @param UserOptions an object of rateLimiter options:
 * ```ts
 * {
 *   timeFrame: 1000,
 *   limit: 1,
 *   onLimitExceeded: (ctx, next) => {},
 *   storageClient: "MEMORY_STORE",
 *   keyGenerator: (ctx) => ctx.from && ctx.from.id.toString(),
 * }
 * ```
 *
 * as explained in [customizability](https://github.com/Amir-Zouerami/rateLimiter#-customizability)
 * @description A middleware function generator
 * @returns a middleware function to be passed to `bot.use()`
 */
export declare const limit: <C extends Context, RT extends RedisType>(userOptions?: OptionsInterface<C, RT> | undefined) => (ctx: C, next: NextFunction) => Promise<void>;
