import type { IStorageEngine, TokenBucketState } from '../types.ts';
import { unref } from '../platform.deno.ts';

/**
 * An in-memory storage record that bundles the state with its expiry timestamp.
 * @template T The type of the state being stored.
 */
interface MemoryRecord<T> {
	state: T;
	expiresAt: number;
}

/**
 * An in-memory storage engine that uses a JavaScript `Map`.
 */
export class MemoryStore implements IStorageEngine {
	private readonly store = new Map<string, MemoryRecord<TokenBucketState | number | boolean>>();
	private readonly cleanupIntervalId?: number | NodeJS.Timeout;

	/**
	 * Constructs a new `MemoryStore`.
	 * **WARNING**: DO NOT PASS `null` to the constructor. It is used for testing purposes only.
	 *
	 * @param cleanupIntervalMs The interval (in milliseconds) at which to sweep
	 * for and remove expired keys. Pass `null` to disable. Defaults to 30 seconds.
	 */
	constructor(cleanupIntervalMs: number | null = 30 * 1000) {
		if (cleanupIntervalMs && cleanupIntervalMs > 0) {
			this.cleanupIntervalId = setInterval(() => this.sweep(), cleanupIntervalMs);
			unref(this.cleanupIntervalId);
		}
	}

	// ... rest of the file is unchanged ...
	/**
	 * The internal garbage collector. It iterates through all stored records
	 * and removes any that have passed their expiration time.
	 */
	private sweep(): void {
		const now = Date.now();

		for (const [key, record] of this.store.entries()) {
			if (record.expiresAt <= now) {
				this.store.delete(key);
			}
		}
	}

	/**
	 * A private helper to retrieve a record from the store.
	 *
	 * It includes a proactive check to delete the record if it has expired
	 * at the moment of retrieval.
	 *
	 * @template T The expected type of the state within the record.
	 * @param key The key of the record to retrieve.
	 * @returns The `MemoryRecord` if it exists and has not expired, otherwise `undefined`.
	 */
	private getRecord<T>(key: string): MemoryRecord<T> | undefined {
		const record = this.store.get(key) as MemoryRecord<T> | undefined;
		if (!record) {
			return undefined;
		}

		if (record.expiresAt <= Date.now()) {
			this.store.delete(key);
			return undefined;
		}
		return record;
	}

	/**
	 * Retrieves the state for a key, used by the Token Bucket strategy.
	 *
	 * @param key The unique key for the record.
	 * @returns A promise that resolves with the `TokenBucketState` or `undefined`.
	 */
	public get(key: string): Promise<TokenBucketState | undefined> {
		const record = this.getRecord<TokenBucketState>(key);
		return Promise.resolve(record?.state);
	}

	/**
	 * Sets the state for a key, used by the Token Bucket strategy.
	 *
	 * @param key The unique key for the record.
	 * @param state The `TokenBucketState` to store.
	 * @param ttl The time-to-live for the record in milliseconds.
	 */
	public set(key: string, state: TokenBucketState, ttl: number): Promise<void> {
		const record: MemoryRecord<TokenBucketState> = {
			state,
			expiresAt: Date.now() + ttl,
		};

		this.store.set(key, record);
		return Promise.resolve();
	}

	/**
	 * Deletes a record from the store.
	 *
	 * @param key The unique key for the record to delete.
	 */
	public delete(key: string): Promise<void> {
		this.store.delete(key);
		return Promise.resolve();
	}

	/**
	 * Atomically increments the hit count for a key, used by the Fixed Window strategy.
	 *
	 * @param key The unique key for the record.
	 * @param ttl The time-to-live for the record in milliseconds.
	 * @returns A promise that resolves with the new hit count.
	 */
	public increment(key: string, ttl: number): Promise<number> {
		let record = this.getRecord<number>(key);

		if (!record) {
			record = { state: 0, expiresAt: 0 };
		}

		record.state += 1;
		record.expiresAt = Date.now() + ttl;

		this.store.set(key, record);
		return Promise.resolve(record.state);
	}

	/**
	 * Sets a penalty for a key, used by the Penalty Box feature.
	 *
	 * @param key The unique key for the penalty.
	 * @param ttl The duration of the penalty in milliseconds.
	 */
	public setPenalty(key: string, ttl: number): Promise<void> {
		const record: MemoryRecord<boolean> = {
			state: true,
			expiresAt: Date.now() + ttl,
		};

		this.store.set(key, record);
		return Promise.resolve();
	}

	/**
	 * Checks if a penalty exists for a key.
	 *
	 * @param key The unique key for the penalty.
	 * @returns A promise that resolves to `true` if a penalty is active, otherwise `false`.
	 */
	public checkPenalty(key: string): Promise<boolean> {
		const record = this.getRecord<boolean>(key);
		return Promise.resolve(record !== undefined);
	}
}
