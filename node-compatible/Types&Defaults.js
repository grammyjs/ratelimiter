"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultOptions = void 0;
exports.defaultOptions = {
    timeFrame: 1000,
    limit: 1,
    onLimitExceeded: (ctx, next) => { },
    storageClient: "MEMORY_STORE",
    keyGenerator: (ctx) => ctx.from && ctx.from.id.toString(),
};
