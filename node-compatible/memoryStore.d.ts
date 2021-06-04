export declare class MemoryStore {
    hits: Map<string, number>;
    constructor(timeFrame: number);
    increment(key: string): number;
}
