import type { IStorageEngine, TokenBucketState } from '../types.ts';

/**
 * Defines the contract for a consumer-provided object that has the methods
 * needed by `RedisStore` to communicate with Redis.
 */
export interface IRedisClient {
	/**
	 * Loads a Lua script into the Redis script cache and returns its SHA1 hash.
	 */
	scriptLoad(script: string): Promise<string>;

	/**
	 * Executes a pre-loaded Lua script by its SHA1 hash.
	 *
	 * @param sha The SHA1 hash of the loaded script
	 * @param keys Array of Redis keys (becomes KEYS[] in Lua)
	 * @param args Array of arguments (becomes ARGV[] in Lua) - should be flat array like [ttl]
	 */
	evalsha(sha: string, keys: string[], args: (string | number)[]): Promise<unknown>;

	/**
	 * Retrieves a value for a key.
	 */
	get(key: string): Promise<string | null>;

	/**
	 * Sets a key with a value and millisecond expiry.
	 *
	 * Implementation examples:
	 * - ioredis: `set(key, value, 'PX', ttlMilliseconds)`
	 * - node-redis: `pSetEx(key, ttlMilliseconds, value)`
	 * - deno-redis: `set(key, value, { px: ttlMilliseconds })`
	 */
	setWithExpiry(key: string, value: string, ttlMilliseconds: number): Promise<unknown>;

	/**
	 * Checks for the existence of a key.
	 * Should return 1 if key exists, 0 if it doesn't.
	 */
	exists(key: string): Promise<number>;

	/**
	 * Deletes a key.
	 */
	del(key: string): Promise<unknown>;
}

const LUA_SCRIPT_ATOMIC_INCREMENT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

/**
 * Tries to determine if a Redis client error is a "NOSCRIPT" error.
 *
 * @param error The error thrown by the Redis client.
 */
function isNoscriptError(error: unknown): boolean {
	if (error instanceof Error && typeof error.message === 'string') {
		return error.message.includes('NOSCRIPT');
	}
	return false;
}

/**
 * A storage engine that uses Redis as the backend.
 */
export class RedisStore implements IStorageEngine {
	private readonly client: IRedisClient;
	private scriptSha: string | null = null;

	/**
	 * Constructs a new `RedisStore`.
	 *
	 * @param client An object that conforms to the `IRedisClient` interface.
	 */
	constructor(client: IRedisClient) {
		this.client = client;
	}

	public async get(key: string): Promise<TokenBucketState | undefined> {
		const state = await this.client.get(key);
		return state ? JSON.parse(state) : undefined;
	}

	public async set(key: string, state: TokenBucketState, ttl: number): Promise<void> {
		await this.client.setWithExpiry(key, JSON.stringify(state), ttl);
	}

	public async delete(key: string): Promise<void> {
		await this.client.del(key);
	}

	public async checkPenalty(key: string): Promise<boolean> {
		const exists = await this.client.exists(key);
		return exists === 1;
	}

	public async setPenalty(key: string, ttl: number): Promise<void> {
		await this.client.setWithExpiry(key, '1', ttl);
	}

	/**
	 * Atomically increments a key using the Lua script above.
	 *
	 * If the Redis script cache is ever flushed (e.g., on a server restart),
	 * this method will try re-caching the script and retrying the `EVALSHA` command.
	 */
	public async increment(key: string, ttl: number): Promise<number> {
		if (!this.scriptSha) {
			this.scriptSha = await this.client.scriptLoad(LUA_SCRIPT_ATOMIC_INCREMENT);
		}

		try {
			const result = await this.client.evalsha(this.scriptSha, [key], [ttl]);
			return result as number;
		} catch (error) {
			if (isNoscriptError(error)) {
				this.scriptSha = await this.client.scriptLoad(LUA_SCRIPT_ATOMIC_INCREMENT);
				const result = await this.client.evalsha(this.scriptSha, [key], [ttl]);

				return result as number;
			}

			throw error;
		}
	}
}
