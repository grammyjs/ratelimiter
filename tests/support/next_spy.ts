import type { NextFunction } from '../../src/types.ts';

/** Tiny call counter for grammY's downstream `next()` callback. */
export interface NextSpy {
	readonly next: NextFunction;
	readonly calls: number;
}

/** Creates a `next()` callback whose invocation count can be asserted. */
export function createNextSpy(): NextSpy {
	let calls = 0;

	return {
		next: () => {
			calls += 1;

			return Promise.resolve();
		},
		get calls(): number {
			return calls;
		},
	};
}
