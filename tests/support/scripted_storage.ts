import type {
	FixedWindowIncrementResult,
	GcraConsumeOptions,
	GcraConsumeResult,
	IStorageEngine,
	PenaltyEscalationApplyOptions,
	PenaltyEscalationResult,
	PenaltyStrikeState,
	SlidingWindowConsumeOptions,
	SlidingWindowConsumeResult,
	StorageOperation,
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
} from '../../src/types.ts';

/** Recorded fixed-window storage invocation. */
export interface IncrementCall {
	readonly key: string;
	readonly ttl: number;
}

/** Recorded Sliding Window storage invocation. */
export interface ConsumeSlidingWindowCall {
	readonly key: string;
	readonly options: SlidingWindowConsumeOptions;
}

/** Recorded token-bucket storage invocation. */
export interface ConsumeTokenBucketCall {
	readonly key: string;
	readonly options: TokenBucketConsumeOptions;
}

/** Recorded GCRA storage invocation. */
export interface ConsumeGcraCall {
	readonly key: string;
	readonly options: GcraConsumeOptions;
}

/** Recorded escalating-penalty storage invocation. */
export interface ApplyEscalatingPenaltyCall {
	readonly penaltyKey: string;
	readonly strikeKey: string;
	readonly options: PenaltyEscalationApplyOptions;
}

/**
 * Scriptable storage double for strategy and middleware unit tests.
 *
 * It does not emulate a real database. Storage correctness belongs to the shared
 * storage contract suite; this double exists only to make unit tests assert the
 * exact collaboration between middleware/strategies and the storage port.
 */
export class ScriptedStorage implements IStorageEngine {
	public readonly incrementCalls: IncrementCall[] = [];
	public readonly consumeSlidingWindowCalls: ConsumeSlidingWindowCall[] = [];
	public readonly consumeTokenBucketCalls: ConsumeTokenBucketCall[] = [];
	public readonly consumeGcraCalls: ConsumeGcraCall[] = [];
	public readonly escalatingPenaltyCalls: ApplyEscalatingPenaltyCall[] = [];
	public readonly penaltyChecks: string[] = [];
	public readonly penaltyWrites: Array<{ key: string; ttl: number }> = [];
	public readonly deletedKeys: string[] = [];

	public incrementResults: FixedWindowIncrementResult[] = [];
	public slidingWindowResults: SlidingWindowConsumeResult[] = [];
	public tokenBucketResults: TokenBucketConsumeResult[] = [];
	public gcraResults: GcraConsumeResult[] = [];
	public escalatingPenaltyResults: PenaltyEscalationResult[] = [];
	public activePenalties = new Set<string>();
	public readonly failures = new Map<StorageOperation, unknown>();

	private readonly genericState = new Map<string, unknown>();
	private readonly strikeState = new Map<string, PenaltyStrikeState>();

	private throwIfFailed(operation: StorageOperation): void {
		if (this.failures.has(operation)) {
			throw this.failures.get(operation);
		}
	}

	public get<T>(key: string): Promise<T | undefined> {
		this.throwIfFailed('get');

		return Promise.resolve(this.genericState.get(key) as T | undefined);
	}

	public set<T>(key: string, state: T, _ttl: number): Promise<void> {
		this.throwIfFailed('set');
		this.genericState.set(key, state);

		return Promise.resolve();
	}

	public delete(key: string): Promise<void> {
		this.throwIfFailed('delete');
		this.deletedKeys.push(key);
		this.genericState.delete(key);
		this.activePenalties.delete(key);
		this.strikeState.delete(key);

		return Promise.resolve();
	}

	public increment(key: string, ttl: number): Promise<FixedWindowIncrementResult> {
		this.throwIfFailed('increment');
		this.incrementCalls.push({ key, ttl });

		const result = this.incrementResults.shift();

		if (!result) {
			throw new Error('ScriptedStorage: no fixed-window result was queued.');
		}

		return Promise.resolve(result);
	}

	public consumeSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult> {
		this.throwIfFailed('consumeSlidingWindow');
		this.consumeSlidingWindowCalls.push({ key, options: { ...options } });

		const result = this.slidingWindowResults.shift();

		if (!result) {
			throw new Error('ScriptedStorage: no sliding-window result was queued.');
		}

		return Promise.resolve(result);
	}

	public consumeTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult> {
		this.throwIfFailed('consumeTokenBucket');
		this.consumeTokenBucketCalls.push({ key, options: { ...options } });

		const result = this.tokenBucketResults.shift();

		if (!result) {
			throw new Error('ScriptedStorage: no token-bucket result was queued.');
		}

		return Promise.resolve(result);
	}

	public consumeGcra(
		key: string,
		options: GcraConsumeOptions,
	): Promise<GcraConsumeResult> {
		this.throwIfFailed('consumeGcra');
		this.consumeGcraCalls.push({ key, options: { ...options } });

		const result = this.gcraResults.shift();

		if (!result) {
			throw new Error('ScriptedStorage: no GCRA result was queued.');
		}

		return Promise.resolve(result);
	}

	public setPenalty(key: string, ttl: number): Promise<void> {
		this.throwIfFailed('setPenalty');
		this.penaltyWrites.push({ key, ttl });
		this.activePenalties.add(key);

		return Promise.resolve();
	}

	public applyEscalatingPenalty(
		penaltyKey: string,
		strikeKey: string,
		options: PenaltyEscalationApplyOptions,
	): Promise<PenaltyEscalationResult> {
		this.throwIfFailed('applyEscalatingPenalty');
		this.escalatingPenaltyCalls.push({ penaltyKey, strikeKey, options: { ...options } });

		const result = this.escalatingPenaltyResults.shift();

		if (!result) {
			throw new Error('ScriptedStorage: no escalating-penalty result was queued.');
		}

		this.activePenalties.add(penaltyKey);
		this.strikeState.set(strikeKey, {
			strikes: result.strikes,
			lastPenaltyTime: result.penaltyTime,
			reset: result.reset,
		});

		return Promise.resolve(result);
	}

	public getPenaltyStrikeState(strikeKey: string): Promise<PenaltyStrikeState | undefined> {
		return Promise.resolve(this.strikeState.get(strikeKey));
	}

	public checkPenalty(key: string): Promise<boolean> {
		this.throwIfFailed('checkPenalty');
		this.penaltyChecks.push(key);

		return Promise.resolve(this.activePenalties.has(key));
	}
}
