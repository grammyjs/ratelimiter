interface User {
  id: number;
  "is_bot": boolean;
  "first_name": string;
  "last_name"?: string;
  "username"?: string;
  "language_code"?: string;
}

export interface Context {
  from: User | undefined;
}

export interface RedisType {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
}

export type NextFunction = () => Promise<void>;

export interface OptionsInterface<C extends Context, RT extends RedisType> {
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
   * @param REDIS which is your redis client you get from [ioredis](https://github.com/luin/ioredis) or [x\redis](https://deno.land/x/redis) library.
   * @description The type of storage to use for keeping track of users and their requests.
   */
  storageClient?: "MEMORY_STORE" | RT;

  /**
   * @param ctx Is the context object you get from grammy/telegraf.
   * @param next Is the next function you get from grammy/telegraf.
   * @description Executed Only once in each timeframe. By default it does nothing so the user is not notified of rate-limiting. The middleware simply ignores excessive requests and the user just has to wait.
   */
  onLimitExceeded?: (ctx: C, next: NextFunction) => void;

  /**
   * @param ctx Is the context object you get from grammy/telegraf.
   * @returns A number in **string** format as the unique key (identifier).
   * @description A function to generate a unique key for every user. You cound set it as any key you want (e.g group id)
   * @see [Getting Started](https://github.com/Amir-Zouerami/rateLimiter#-how-to-use)
   */
  keyGenerator?: (ctx: C) => string | undefined;
}

export const defaultOptions = {
  timeFrame: 1000,
  limit: 1,
  onLimitExceeded: (_ctx: Context, _next: NextFunction) => {},
  storageClient: "MEMORY_STORE",
  keyGenerator: (ctx: Context) => ctx.from === undefined ? undefined : ctx.from.id.toString(),
};
