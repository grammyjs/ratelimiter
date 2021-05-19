import { MemoryStore } from "./memoryStore";
import { Context, NextFunction, MiddlewareFn } from "grammy";
import { OptionsInterface, defaultOptions } from "./Types&Defaults";
import { RedisStore } from "./redisStore";
import { Redis } from "ioredis";

/**
 * 
 * @param UserOptions an object of desired options:
 * ```{
 *  timeFrame,
 *  limit,
 *  onLimitExceeded,
 *  storageClient,
 *  keyGenerator
 * }```
 * 
 * as explained in https://github.com/Amir-Zouerami/ratelimYter-grammY#-customizability
 * @returns a middleware function to be passed to a middleware using `bot.use()`
 * @description A middleware function generator
 */

export const limit = (UserOptions?: OptionsInterface) => {
    const options = { ...defaultOptions, ...UserOptions };
    const store = options.storageClient === "MEMORY_STORE" ?
        new MemoryStore(options.timeFrame) :
        new RedisStore(options.storageClient as Redis, options.timeFrame);


    const middlewareFunc: MiddlewareFn = async (ctx: Context, next: NextFunction) => {
        let keyCheck = options.keyGenerator(ctx);
        if (!keyCheck) {
            return next();
        }

        const key = "RATE_LIMYTER" + keyCheck;
        const hits = await store.increment(key);

        if (hits === options.limit + 1) {
            return options.onLimitExceeded(ctx, next);
        }

        if (hits <= options.limit) {
            return next();
        }
    }

    return middlewareFunc;
}