import { FakeClock } from '../../support/fake_clock.ts';
import { MemoryStore } from '../../../src/stores/memory.ts';
import { defineStorageContract } from '../../contracts/storage_contract.ts';
import { defineInspectionStorageContract } from '../../contracts/inspection_contract.ts';

defineStorageContract('MemoryStore', () => {
	const clock = new FakeClock().install();
	const storage = new MemoryStore(null);

	return {
		storage,
		advance(milliseconds: number): void {
			clock.advance(milliseconds);
		},
		cleanup(): void {
			storage.close();
			clock.restore();
		},
	};
});

defineInspectionStorageContract('MemoryStore', () => {
	const clock = new FakeClock().install();
	const storage = new MemoryStore(null);

	return {
		storage,
		advance(milliseconds: number): void {
			clock.advance(milliseconds);
		},
		cleanup(): void {
			storage.close();
			clock.restore();
		},
	};
});
