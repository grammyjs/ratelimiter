import { MemoryStore } from "./memoryStore";
import { Context, NextFunction, MiddlewareFn } from "grammy";
import { OptionsInterface, defaultOptions } from "./Types&Defaults";


export const limit = (UserOptions?: OptionsInterface): MiddlewareFn => {
    const options = { ...defaultOptions, ...UserOptions };
    const store = new MemoryStore(options.timeFrame);

    const middlewareFunc = (ctx: Context, next: NextFunction) => {
        const key = options.keyGenerator(ctx);
        if (!key) {
            return next();
        }

        const hits = store.increment(key);

        if (hits > options.limit) {
            if (!store.limiterAlreadyResponded()) {
                store.exceededLimit();
                return options.onLimitExceeded(ctx)
            }
        } else {
            return next();
        }
    }

    return middlewareFunc;
}