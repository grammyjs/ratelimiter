export class MemoryStore {
    hits = new Map();
    limiterResponded = false;

    constructor(timeFrame: number) {
        setInterval(() => { this.hits.clear(), this.limiterResponded = false }, timeFrame);
    }

    exceededLimit() {
        this.limiterResponded = true;
    }

    limiterAlreadyResponded() {
        return this.limiterResponded;
    }

    increment(key: number): number {
        let counter = this.hits.get(key) ?? 0;
        counter++;
        this.hits.set(key, counter);
        return counter;
    }
}