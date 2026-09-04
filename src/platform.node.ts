interface UnrefableTimer {
	unref(): void;
}

/**
 * Detaches a timer from Node.js event-loop liveness tracking.
 *
 * This is the Node counterpart of `platform.deno.ts` used by the `deno2node`
 * build. Keeping the runtime difference behind this tiny module prevents
 * storage implementations from depending directly on Node-specific timer types.
 */
export const unref = (timer: number | object): void => {
	(timer as UnrefableTimer).unref();
};
