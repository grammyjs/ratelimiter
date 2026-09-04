/**
 * # Rate Limiter Storage Engines
 *
 * Built-in storage implementations for `@grammyjs/ratelimiter`.
 *
 * `MemoryStore` is process-local and intended for single-process deployments or
 * development. `RedisStore` provides shared, atomic state suitable for multiple
 * processes or machines when backed by the same Redis instance.
 *
 * @module
 */

export { MemoryStore } from './src/stores/memory.ts';
export { type IRedisClient, RedisStore } from './src/stores/redis.ts';
