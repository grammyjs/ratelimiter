import assert from 'node:assert/strict';
import test from 'node:test';

import { limit, Limiter } from '@grammyjs/ratelimiter';
import { MemoryStore } from '@grammyjs/ratelimiter/storages';

const createMockContext = (id) => ({
	from: { id },
	chat: { id },
});

test('built package runs under Node.js through package exports', async () => {
	const limiter = new Limiter()
		.useStorage(new MemoryStore(null))
		.fixedWindow({ limit: 1, timeFrame: 1_000 })
		.limitFor('user')
		.withKeyPrefix('node-smoke');

	const middleware = limit(limiter);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;
		return Promise.resolve();
	};

	await middleware(createMockContext(100), next);
	await middleware(createMockContext(100), next);

	assert.equal(nextCalls, 1);
});
