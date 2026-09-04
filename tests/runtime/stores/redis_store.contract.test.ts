import { FakeClock } from '../../support/fake_clock.ts';
import { RedisStore } from '../../../src/stores/redis.ts';
import { FakeRedisClient } from '../../support/fake_redis_client.ts';
import { defineStorageContract } from '../../contracts/storage_contract.ts';
import { defineInspectionStorageContract } from '../../contracts/inspection_contract.ts';

defineStorageContract('RedisStore (simulated Redis)', () => {
	const clock = new FakeClock().install();
	const client = new FakeRedisClient(() => clock.now);

	return {
		storage: new RedisStore(client),
		advance(milliseconds: number): void {
			clock.advance(milliseconds);
		},
		cleanup(): void {
			clock.restore();
		},
	};
});

defineInspectionStorageContract('RedisStore (simulated Redis)', () => {
	const clock = new FakeClock().install();
	const client = new FakeRedisClient(() => clock.now);

	return {
		storage: new RedisStore(client),
		advance(milliseconds: number): void {
			clock.advance(milliseconds);
		},
		cleanup(): void {
			clock.restore();
		},
	};
});
