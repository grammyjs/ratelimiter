"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisStore = void 0;
class RedisStore {
    constructor(client, timeFrame) {
        this.client = client;
        this.timeFrame = timeFrame;
    }
    async increment(key) {
        const counter = await this.client.incr(key);
        if (counter === 1) {
            await this.client.pexpire(key, this.timeFrame);
        }
        return counter;
    }
}
exports.RedisStore = RedisStore;
