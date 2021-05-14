import { Context } from "grammy"
import { NextFunction } from "grammy"

export interface Options {
    timeFrame?: number;
    limit?: number;
    onLimitExceeded?: (ctx?: Context, next?: NextFunction) => void;
    keyGenerator?: (ctx: Context) => {};
}

export const defaults = {
    respondToSpam: (ctx?: Context, next?: NextFunction) => { },
    // Example: ctx?.reply("Please refrain from sending too many requests.")
    generateId: (ctx: Context) => ctx.from && ctx.from.id,
}