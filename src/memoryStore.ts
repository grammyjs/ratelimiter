import { unref } from "./platform.deno.ts";

export class MemoryStore {
  hits = new Map<string, number>();

  constructor(timeFrame: number) {
    unref(setInterval(() => {
      this.hits.clear();
    }, timeFrame));
  }

  increment(key: string): number {
    let counter = this.hits.get(key) ?? 0;
    counter++;
    this.hits.set(key, counter);
    return counter;
  }
}
