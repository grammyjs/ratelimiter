import { MemoryStore } from "./memoryStore.ts";
import {
  Context,
  defaultOptions,
  NextFunction,
  OptionsInterface,
  RedisType,
} from "./typesAndDefaults.ts";
import { RedisStore } from "./redisStore.ts";

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

export const limit = <C extends Context, RT extends RedisType>(
  userOptions?: OptionsInterface<C, RT>,
) => {
  const options = { ...defaultOptions, ...userOptions };
  const store = options.storageClient === "MEMORY_STORE"
    ? new MemoryStore(options.timeFrame)
    : new RedisStore(options.storageClient as RT, options.timeFrame);

  const middlewareFunc = async (ctx: C, next: NextFunction) => {
    const keyCheck = options.keyGenerator(ctx);
    if (!keyCheck) {
      return await next();
    }

    const key = "RATE_LIMITER" + keyCheck;
    const hits = await store.increment(key);
    
    if (hits === options.limit + 1 || (options.replyAlways && hits > options.limit)) {
      return options.onLimitExceeded(ctx, next);
    }
    
    if (hits <= options.limit) {
      return await next();
    }
  };

  return middlewareFunc;
};
