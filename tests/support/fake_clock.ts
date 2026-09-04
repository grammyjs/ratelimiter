/**
 * Deterministic wall clock for runtime tests that depend on `Date.now()`.
 *
 * The clock deliberately patches only `Date.now`; it does not fake timers. This
 * keeps tests synchronous and predictable while avoiding coupling production
 * code to a test-only clock abstraction. Tests that install a clock must restore
 * it before returning.
 */
export class FakeClock {
	private readonly originalNow = Date.now;
	private installed = false;

	constructor(private currentTimeMs = 1_000_000) {}

	/** Current fake timestamp in milliseconds. */
	public get now(): number {
		return this.currentTimeMs;
	}

	/** Installs this clock as the process-wide `Date.now()` source. */
	public install(): this {
		if (this.installed) {
			throw new Error('FakeClock: clock is already installed.');
		}

		this.installed = true;
		Date.now = () => this.currentTimeMs;

		return this;
	}

	/** Advances the fake wall clock without waiting in real time. */
	public advance(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) {
			throw new Error('FakeClock: advance duration must be a finite non-negative number.');
		}

		this.currentTimeMs += milliseconds;
	}

	/** Restores the original `Date.now()` implementation. */
	public restore(): void {
		if (!this.installed) {
			return;
		}

		Date.now = this.originalNow;
		this.installed = false;
	}
}

/** Runs a test body with an installed fake clock and always restores it. */
export async function withFakeClock<T>(
	run: (clock: FakeClock) => T | Promise<T>,
	initialTimeMs = 1_000_000,
): Promise<T> {
	const clock = new FakeClock(initialTimeMs).install();

	try {
		return await run(clock);
	} finally {
		clock.restore();
	}
}
