import { RedisType } from "./Types&Defaults.ts";

export class RedisStore<RT extends RedisType> {
  private client: RT;
  timeFrame: number;

  constructor(client: RT, timeFrame: number) {
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
