import { RedisType } from "./typesAndDefaults.ts";

export class RedisStore {
  private client: RedisType;
  timeFrame: number;

  constructor(client: RedisType, timeFrame: number) {
    this.client = client;
    this.timeFrame = timeFrame;
  }

  async increment(key: string): Promise<number> {
    const counter = await this.client.incr(key);

    if (counter === 1) {
      await this.client.pexpire(key, this.timeFrame);
    }
    return counter;
  }
}
