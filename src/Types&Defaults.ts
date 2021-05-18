import { Context } from "grammy"
import { NextFunction } from "grammy"
import { Redis } from "ioredis";

export type StorageType = "MEMORY_STORE" | Redis;

export interface OptionsInterface {
    /**
     * @default 1000 (miliseconds)
     * @description The time frame during which the requests will be monitored
     */
    timeFrame?: number;

    /**
     * @default 1
     * @description the number of requests a user is allowed to send in a specific timeFrame
     */
    limit?: number;

    /**
     * @default MEMORY_STORE
     * @param MEMORY_STORE which uses the a Map() in memory
     * @param REDIS which is your redis client you get from "ioredis" library. You have to have redis-server version 6.0 and above installed on your server. Older versions of Redis are not supported.
     * @description The type of storage to use for keeping track of users and their requests.
     */
    storageClient?: StorageType;

    /**
     * @param ctx Is the context object you get from grammy.
     * @param next Is the next function you get from grammy.
     * @description Executed Only once in each timeframe. By default it does nothing so the user is not notified of rate-limiting. The middleware simply ignores excessive requests and the user just has to wait.
     */
    onLimitExceeded?: (ctx: Context, next: NextFunction) => void;

    /**
     * @param ctx Is the context object you get from grammy.
     * @returns A number in **string** format as the unique key (identifier). 
     * @description A function to generate a unique key for every user. You cound set it as any key you want (e.g group id)
     * @see https://github.com/Amir-Zouerami/ratelimYter-grammY#-how-to-use
     */
    keyGenerator?: (ctx: Context) => string | void;
}

export const defaultOptions = {
    timeFrame: 1000,
    limit: 1,
    onLimitExceeded: (ctx?: Context, next?: NextFunction) => { },
    storageClient: "MEMORY_STORE",
    keyGenerator: (ctx: Context) => ctx.from && ctx.from.id.toString(),
}