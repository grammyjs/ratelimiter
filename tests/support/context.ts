import type { GrammyContext } from '../../src/types.ts';

/** Options for the minimal grammY-compatible contexts used by middleware tests. */
export interface TestContextOptions {
	userId?: number;
	chatId?: number;
	text?: string;
}

/**
 * Creates the smallest structurally valid context shape needed by ratelimiter.
 *
 * Runtime middleware tests intentionally do not construct grammY's internal
 * `Context` class because ratelimiter only relies on the public `from`/`chat`
 * surface. Compatibility with grammY's actual context type is checked separately
 * in `tests/types`, where it cannot be confused with runtime behavior coverage.
 */
export function createTestContext(options: TestContextOptions = {}): GrammyContext {
	const userId = options.userId ?? 100;
	const chatId = options.chatId ?? userId;
	const from = { id: userId, is_bot: false, first_name: 'test-user' };
	const chat = { id: chatId, type: 'private' as const, first_name: 'test-user' };

	return {
		from,
		chat,
		...(options.text === undefined ? {} : {
			message: {
				message_id: 1,
				date: 0,
				chat,
				from,
				text: options.text,
			},
		}),
	} as unknown as GrammyContext;
}
