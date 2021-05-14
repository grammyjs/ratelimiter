export class MemoryStore {
    hits = new Map();

    constructor(timeFrame: number) {
        setInterval(() => { this.hits.clear() }, timeFrame);
    }

    increment(key: number): number {
        let counter = this.hits.get(key) ?? 0;
        counter++;
        this.hits.set(key, counter);
        return counter;
    }
}