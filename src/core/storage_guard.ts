import type {
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	FixedWindowIncrementResult,
	GcraConsumeOptions,
	GcraConsumeResult,
	IStorageEngine,
	PenaltyEscalationApplyOptions,
	PenaltyEscalationResult,
	SlidingWindowConsumeOptions,
	SlidingWindowConsumeResult,
	StorageOperation,
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
} from '../types.ts';

/**
 * @internal Error wrapper used only to distinguish storage failures from
 * strategy/application failures.
 */
export class StorageOperationError extends Error {
	public readonly operation: StorageOperation;
	public readonly key: string;
	public override readonly cause: unknown;

	constructor(operation: StorageOperation, key: string, cause: unknown) {
		super(`Storage operation '${operation}' failed for key '${key}'.`);
		this.name = 'StorageOperationError';
		this.operation = operation;
		this.key = key;
		this.cause = cause;
	}
}

/** Executes one storage call and tags only failures originating from that call. */
async function guard<T>(
	operation: StorageOperation,
	key: string,
	call: () => Promise<T>,
): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw new StorageOperationError(operation, key, error);
	}
}

/**
 * @internal Wraps a storage engine without changing its successful behavior.
 *
 * The wrapper is created once per middleware instance. Its only purpose is to
 * make storage failures distinguishable from exceptions thrown by custom
 * strategy code, so fail-open behavior can never accidentally hide a strategy
 * defect.
 */
export function guardStorage(storage: IStorageEngine): IStorageEngine {
	const guarded: IStorageEngine = {
		get: <T>(key: string) => guard('get', key, () => storage.get<T>(key)),
		set: <T>(key: string, state: T, ttl: number) =>
			guard('set', key, () => storage.set(key, state, ttl)),
		delete: (key: string) => guard('delete', key, () => storage.delete(key)),
		increment: (key: string, ttl: number): Promise<FixedWindowIncrementResult> =>
			guard('increment', key, () => storage.increment(key, ttl)),
		consumeSlidingWindow: (
			key: string,
			options: SlidingWindowConsumeOptions,
		): Promise<SlidingWindowConsumeResult> =>
			guard('consumeSlidingWindow', key, () => storage.consumeSlidingWindow(key, options)),
		consumeTokenBucket: (
			key: string,
			options: TokenBucketConsumeOptions,
		): Promise<TokenBucketConsumeResult> =>
			guard('consumeTokenBucket', key, () => storage.consumeTokenBucket(key, options)),
		consumeGcra: (
			key: string,
			options: GcraConsumeOptions,
		): Promise<GcraConsumeResult> =>
			guard('consumeGcra', key, () => storage.consumeGcra(key, options)),
		setPenalty: (key: string, ttl: number) =>
			guard('setPenalty', key, () => storage.setPenalty(key, ttl)),
		checkPenalty: (key: string) => guard('checkPenalty', key, () => storage.checkPenalty(key)),
	};

	if (storage.consumeAtomicLimit !== undefined) {
		guarded.consumeAtomicLimit = (
			layers: readonly AtomicLimitLayerInput[],
		): Promise<AtomicLimitConsumeResult> =>
			guard(
				'consumeAtomicLimit',
				layers[0]?.operation.key ?? '<atomic-limit>',
				() => storage.consumeAtomicLimit!(layers),
			);
	}

	if (storage.applyEscalatingPenalty !== undefined) {
		guarded.applyEscalatingPenalty = (
			penaltyKey: string,
			strikeKey: string,
			options: PenaltyEscalationApplyOptions,
		): Promise<PenaltyEscalationResult> =>
			guard(
				'applyEscalatingPenalty',
				penaltyKey,
				() => storage.applyEscalatingPenalty!(penaltyKey, strikeKey, options),
			);
	}

	return guarded;
}
