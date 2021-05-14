import { MemoryStore } from "./memoryStore";
import { Context, NextFunction } from "grammy";
import { Options, defaults } from "./Types&Defaults";


export const limit = (options?: Options): (ctx: Context, next: NextFunction) => void => {
    const config = Object.assign({
        timeFrame: 1000,
        limit: 1,
        onLimitExceeded: defaults.respondToSpam,
        keyGenerator: defaults.generateId,
    }, options);

    const store = new MemoryStore(config.timeFrame);
    const middlewareFunc = (ctx: Context, next: NextFunction) => {
        const key = config.keyGenerator(ctx);
        if (!key) {
            return next();
        }
        const hit = store.increment(key);
        return hit <= config.limit ? next() : config.onLimitExceeded(ctx, next);
    }
    return middlewareFunc;
}