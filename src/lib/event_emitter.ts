/** Generic internal listener representation. */
// deno-lint-ignore no-explicit-any
type Listener = (...args: any[]) => void;

/** Extracts the argument tuple associated with one event key. */
type EventArgs<T extends object, E extends keyof T> = T[E] extends unknown[] ? T[E] : never;

/**
 * @internal Small synchronous, strongly typed event emitter used by limiter rules.
 *
 * The event-map generic is intentionally constrained only to `object` rather
 * than `Record<string, ...>`. Adding a string index signature would widen
 * `keyof T` to every string and silently destroy event-name autocomplete and
 * typo detection for consumers.
 *
 * Listeners execute in registration order. Exceptions are intentionally not
 * swallowed; a listener that throws aborts the current middleware call, matching
 * normal synchronous event-emitter behavior.
 */
export class EventEmitter<T extends object> {
	private readonly listeners = new Map<keyof T, Set<Listener>>();

	/**
	 * Registers a listener.
	 *
	 * Adding the same function reference more than once has no additional effect.
	 */
	public on<E extends keyof T>(
		eventName: E,
		listener: (...args: EventArgs<T, E>) => void,
	): this {
		const eventListeners = this.listeners.get(eventName) ?? new Set();
		eventListeners.add(listener);
		this.listeners.set(eventName, eventListeners);

		return this;
	}

	/** Removes a previously registered listener, if present. */
	public off<E extends keyof T>(
		eventName: E,
		listener: (...args: EventArgs<T, E>) => void,
	): this {
		this.listeners.get(eventName)?.delete(listener);

		return this;
	}

	/** Emits an event synchronously to all currently registered listeners. */
	public emit<E extends keyof T>(eventName: E, ...args: EventArgs<T, E>): void {
		const eventListeners = this.listeners.get(eventName);
		if (!eventListeners) {
			return;
		}

		for (const listener of eventListeners) {
			listener(...args);
		}
	}

	/**
	 * Creates an independent snapshot of the current listener registry.
	 *
	 * Listener function references are shared, but later `on()`/`off()` calls on
	 * either emitter do not change the other emitter's registration sets.
	 */
	public clone(): EventEmitter<T> {
		const clone = new EventEmitter<T>();

		for (const [eventName, eventListeners] of this.listeners) {
			clone.listeners.set(eventName, new Set(eventListeners));
		}

		return clone;
	}

	/** Returns whether at least one listener is registered for an event. */
	public hasListeners<E extends keyof T>(eventName: E): boolean {
		return (this.listeners.get(eventName)?.size ?? 0) > 0;
	}
}
