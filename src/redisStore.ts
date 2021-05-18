import { Redis } from "ioredis";

export class RedisStore {
    private client: Redis;
    timeFrame: number;
    limiterResponded = false;

    constructor(client: Redis, timeFrame: number) {
        this.client = client;
        this.timeFrame = timeFrame;
    }

    exceededLimit() {
        this.limiterResponded = true;
    }

    limiterAlreadyResponded() {
        return this.limiterResponded;
    }

    async increment(key: string): Promise<number> {
        let counter = await this.client.get(key) ?? 0;

        if (counter === 0) {
            this.limiterResponded = false;
            counter++
            await this.client.set(key, counter, "PX", this.timeFrame);
        }

        if (typeof counter === "string") {
            counter = parseInt(counter);
            counter++
            await this.client.set(key, counter, "KEEPTTL");
        }

        return counter;
    }
}