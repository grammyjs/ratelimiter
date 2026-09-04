import type { EventEmitter } from '../lib/event_emitter.ts';
import type { StorageOperationError } from './storage_guard.ts';

import type {
	GrammyContext,
	LimiterEvents,
	LimiterMetadataFields,
	StorageFailureInfo,
	StorageFailureMode,
	StorageFailurePhase,
	StorageFailurePolicy,
} from '../types.ts';

const STORAGE_FAILURE_MODES = new Set<StorageFailureMode>([
	'throw',
	'fail-open',
	'fail-closed',
]);

/**
 * @internal Resolves one tagged storage failure and emits observability metadata.
 */
export async function resolveStorageFailure<
	C extends GrammyContext,
	M extends LimiterMetadataFields | undefined = undefined,
>(
	ctx: C,
	events: EventEmitter<LimiterEvents<C, M>>,
	policy: StorageFailurePolicy<C>,
	phase: StorageFailurePhase,
	entityKey: string,
	error: StorageOperationError,
): Promise<StorageFailureMode> {
	const info: StorageFailureInfo = {
		phase,
		operation: error.operation,
		key: error.key,
		entityKey,
		error: error.cause,
	};

	if (events.hasListeners('storageError')) {
		events.emit('storageError', ctx, info);
	}

	const mode = typeof policy === 'function' ? await policy(ctx, info) : policy;

	if (!STORAGE_FAILURE_MODES.has(mode)) {
		throw new Error(
			"Limiter: storage failure policy resolver must return 'throw', 'fail-open', or 'fail-closed'.",
		);
	}

	return mode;
}
