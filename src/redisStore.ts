import { Redis } from "ioredis";

export class RedisStore {
    private client: Redis;
    timeFrame: number;

    constructor(client: Redis, timeFrame: number) {
        this.client = client;
        this.timeFrame = timeFrame;
    }

    async increment(key: string): Promise<number> {
        let counter = await this.client.incr(key);

        if (counter === 1) {
            await this.client.pexpire(key, this.timeFrame);
        }
        return counter;
    }
}