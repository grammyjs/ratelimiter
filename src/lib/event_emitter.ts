import type { EventMap } from '../types.ts';

/**
 * A type alias for a generic listener function.
 */
// deno-lint-ignore no-explicit-any
type Listener = (...args: any[]) => void;

/**
 * A simple event emitter.
 */
export class EventEmitter<T extends EventMap> {
	private readonly listeners = new Map<keyof T, Set<Listener>>();

	/**
	 * Registers a listener for a given event.
	 *
	 * @param eventName The name of the event to listen to.
	 * @param listener The function to call when the event is emitted.
	 */
	public on<E extends keyof T>(eventName: E, listener: (...args: T[E]) => void): this {
		const eventListeners = this.listeners.get(eventName) ?? new Set();

		eventListeners.add(listener);
		this.listeners.set(eventName, eventListeners);

		return this;
	}

	/**
	 * Unregisters a listener for a given event.
	 *
	 * @param eventName The name of the event.
	 * @param listener The listener function to remove.
	 */
	public off<E extends keyof T>(eventName: E, listener: (...args: T[E]) => void): this {
		const eventListeners = this.listeners.get(eventName);

		if (eventListeners) {
			eventListeners.delete(listener);
		}

		return this;
	}

	/**
	 * Emits an event.
	 *
	 * @param eventName The name of the event to emit.
	 * @param args The arguments to pass to the listeners.
	 */
	public emit<E extends keyof T>(eventName: E, ...args: T[E]): void {
		const eventListeners = this.listeners.get(eventName);

		if (eventListeners) {
			for (const listener of eventListeners) {
				listener(...args);
			}
		}
	}

	/**
	 * Checks if there are any listeners for a specific event.
	 *
	 * @param eventName The name of the event.
	 * @returns True if at least one listener is registered.
	 */
	public hasListeners<E extends keyof T>(eventName: E): boolean {
		const eventListeners = this.listeners.get(eventName);
		return eventListeners ? eventListeners.size > 0 : false;
	}
}
