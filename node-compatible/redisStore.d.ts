import { RedisType } from "./Types&Defaults.js";
export declare class RedisStore<RT extends RedisType> {
    private client;
    timeFrame: number;
    constructor(client: RT, timeFrame: number);
    increment(key: string): Promise<number>;
}
