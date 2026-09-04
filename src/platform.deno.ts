interface DenoTimerRuntime {
	unrefTimer(timerId: number): void;
}

interface UnrefableTimer {
	unref(): void;
}

/**
 * Detaches a timer from event-loop liveness tracking when the runtime supports it.
 *
 * Deno exposes `Deno.unrefTimer`, while Node.js timer handles expose `.unref()`.
 * Browsers and other runtimes may expose neither mechanism; in that case this
 * helper deliberately becomes a no-op. Keeping the feature detection here makes
 * the JSR source safe to load from both Deno and Node.js without runtime globals
 * being assumed at module-evaluation time.
 */
export const unref = (timer: ReturnType<typeof setInterval>): void => {
	const deno = (globalThis as typeof globalThis & { Deno?: DenoTimerRuntime }).Deno;
	if (deno !== undefined && typeof timer === 'number') {
		deno.unrefTimer(timer);
		return;
	}

	if (
		typeof timer === 'object' &&
		timer !== null &&
		'unref' in timer &&
		typeof (timer as Partial<UnrefableTimer>).unref === 'function'
	) {
		(timer as UnrefableTimer).unref();
	}
};
