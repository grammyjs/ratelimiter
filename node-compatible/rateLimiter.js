"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.limit = void 0;
const memoryStore_js_1 = require("./memoryStore.js");
const Types_Defaults_js_1 = require("./Types&Defaults.js");
const redisStore_js_1 = require("./redisStore.js");
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
const limit = (userOptions) => {
    const options = { ...Types_Defaults_js_1.defaultOptions, ...userOptions };
    const store = options.storageClient === "MEMORY_STORE"
        ? new memoryStore_js_1.MemoryStore(options.timeFrame)
        : new redisStore_js_1.RedisStore(options.storageClient, options.timeFrame);
    const middlewareFunc = async (ctx, next) => {
        const keyCheck = options.keyGenerator(ctx);
        if (!keyCheck) {
            return await next();
        }
        const key = "RATE_LIMITER" + keyCheck;
        const hits = await store.increment(key);
        if (hits === options.limit + 1) {
            return options.onLimitExceeded(ctx, next);
        }
        if (hits <= options.limit) {
            return await next();
        }
    };
    return middlewareFunc;
};
exports.limit = limit;
