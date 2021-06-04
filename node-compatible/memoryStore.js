"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryStore = void 0;
class MemoryStore {
    constructor(timeFrame) {
        this.hits = new Map();
        setInterval(() => {
            this.hits.clear();
        }, timeFrame);
    }
    increment(key) {
        var _a;
        let counter = (_a = this.hits.get(key)) !== null && _a !== void 0 ? _a : 0;
        counter++;
        this.hits.set(key, counter);
        return counter;
    }
}
exports.MemoryStore = MemoryStore;
