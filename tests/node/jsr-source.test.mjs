import test from 'node:test';
import assert from 'node:assert/strict';

test('raw JSR storage entry initializes under Node without a Deno global', async () => {
	assert.equal(globalThis.Deno, undefined);

	const { MemoryStore, RedisStore } = await import('../../storages.ts');
	const storage = new MemoryStore();

	storage.close();
	assert.equal(typeof RedisStore, 'function');
});
