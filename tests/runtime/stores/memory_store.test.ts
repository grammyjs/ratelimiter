import { assertThrows } from '@std/assert';
import { MemoryStore } from '../../../src/stores/memory.ts';

Deno.test('MemoryStore validates its cleanup interval', () => {
	assertThrows(() => new MemoryStore(-1), Error, 'finite non-negative');
	assertThrows(() => new MemoryStore(Number.NaN), Error, 'finite non-negative');
});
