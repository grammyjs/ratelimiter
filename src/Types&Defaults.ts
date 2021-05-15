import { Context } from "grammy"
import { NextFunction } from "grammy"

export interface OptionsInterface {
    timeFrame?: number;
    limit?: number;
    onLimitExceeded?: (ctx?: Context, next?: NextFunction) => void;
    keyGenerator?: (ctx: Context) => number | undefined;
}

export const defaultOptions = {
    timeFrame: 1000,
    limit: 1,
    onLimitExceeded: (ctx?: Context, next?: NextFunction) => { },
    keyGenerator: (ctx: Context) => ctx.from && ctx.from.id,
}