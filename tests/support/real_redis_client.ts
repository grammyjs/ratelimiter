import type { IRedisClient } from '../../src/stores/redis.ts';

type RedisScalar = string | number | null;

type RedisReply = RedisScalar | RedisReply[];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const output = new Uint8Array(total);
	let offset = 0;

	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}

	return output;
}

function encodeCommand(parts: readonly (string | number)[]): Uint8Array {
	const chunks: Uint8Array[] = [encoder.encode(`*${parts.length}\r\n`)];

	for (const part of parts) {
		const bytes = encoder.encode(String(part));

		chunks.push(encoder.encode(`$${bytes.length}\r\n`), bytes, encoder.encode('\r\n'));
	}

	return concatBytes(chunks);
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
	let written = 0;

	while (written < bytes.length) {
		written += await conn.write(bytes.subarray(written));
	}
}

class RespReader {
	private buffer = new Uint8Array(0);
	private offset = 0;

	constructor(private readonly conn: Deno.Conn) {}

	public async readReply(): Promise<RedisReply> {
		const prefix = String.fromCharCode(await this.readByte());

		switch (prefix) {
			case '+':
				return await this.readLine();
			case '-':
				throw new Error(await this.readLine());
			case ':':
				return this.parseInteger(await this.readLine());
			case '$': {
				const length = this.parseInteger(await this.readLine());

				if (length === -1) return null;

				if (length < -1) throw new Error(`Invalid RESP bulk-string length: ${length}.`);

				const payload = await this.readExact(length);

				await this.expectCrlf();

				return decoder.decode(payload);
			}
			case '*': {
				const length = this.parseInteger(await this.readLine());

				if (length === -1) return null;

				if (length < -1) throw new Error(`Invalid RESP array length: ${length}.`);

				const values: RedisReply[] = [];

				for (let index = 0; index < length; index += 1) {
					values.push(await this.readReply());
				}

				return values;
			}
			default:
				throw new Error(`Unsupported RESP reply prefix '${prefix}'.`);
		}
	}

	private async readByte(): Promise<number> {
		await this.ensureAvailable(1);

		const value = this.buffer[this.offset++];

		if (value === undefined) throw new Error('RESP reader buffer underflow.');

		return value;
	}

	private async readLine(): Promise<string> {
		const bytes: number[] = [];

		while (true) {
			const byte = await this.readByte();

			if (byte === 13) {
				const lineFeed = await this.readByte();

				if (lineFeed !== 10) throw new Error('Malformed RESP line ending.');

				return decoder.decode(Uint8Array.from(bytes));
			}

			bytes.push(byte);
		}
	}

	private async readExact(length: number): Promise<Uint8Array> {
		await this.ensureAvailable(length);

		const value = this.buffer.slice(this.offset, this.offset + length);

		this.offset += length;

		return value;
	}

	private async expectCrlf(): Promise<void> {
		const carriageReturn = await this.readByte();
		const lineFeed = await this.readByte();

		if (carriageReturn !== 13 || lineFeed !== 10) {
			throw new Error('Malformed RESP bulk-string terminator.');
		}
	}

	private parseInteger(value: string): number {
		const parsed = Number(value);

		if (!Number.isSafeInteger(parsed)) {
			throw new Error(`Invalid RESP integer '${value}'.`);
		}

		return parsed;
	}

	private async ensureAvailable(length: number): Promise<void> {
		while (this.buffer.length - this.offset < length) {
			const unread = this.buffer.subarray(this.offset);
			const chunk = new Uint8Array(8_192);
			const count = await this.conn.read(chunk);

			if (count === null) throw new Error('Redis closed the connection before replying.');

			this.buffer = concatBytes([unread, chunk.subarray(0, count)]);
			this.offset = 0;
		}
	}
}

interface RedisEndpoint {
	readonly hostname: string;
	readonly port: number;
	readonly secure: boolean;
	readonly username?: string;
	readonly password?: string;
	readonly database: number;
}

function parseRedisUrl(value: string): RedisEndpoint {
	const url = new URL(value);

	if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
		throw new Error("RealRedisClient expects a 'redis://' or 'rediss://' URL.");
	}

	const port = url.port === '' ? 6379 : Number(url.port);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid Redis port '${url.port}'.`);
	}

	const databaseText = url.pathname.replace(/^\//, '');
	const database = databaseText === '' ? 0 : Number(databaseText);

	if (!Number.isInteger(database) || database < 0) {
		throw new Error(`Invalid Redis database '${databaseText}'.`);
	}

	const username = url.username === '' ? undefined : decodeURIComponent(url.username);
	const password = url.password === '' ? undefined : decodeURIComponent(url.password);

	if (username !== undefined && password === undefined) {
		throw new Error('Redis URL usernames require a password.');
	}

	return {
		hostname: url.hostname,
		port,
		secure: url.protocol === 'rediss:',
		username,
		password,
		database,
	};
}

/**
 * Dependency-free Redis client used only by the real integration suite.
 *
 * A fresh TCP/TLS connection is opened for every command. That keeps the helper
 * deliberately small while allowing Promise-based concurrency tests to create
 * genuine overlapping requests against Redis.
 */
export class RealRedisClient implements IRedisClient {
	private readonly endpoint: RedisEndpoint;

	constructor(redisUrl: string) {
		this.endpoint = parseRedisUrl(redisUrl);
	}

	/** Verifies that the target Redis server is reachable. */
	public async ping(): Promise<void> {
		const result = await this.command(['PING']);

		if (result !== 'PONG') throw new Error(`Unexpected Redis PING reply: ${String(result)}.`);
	}

	/** Flushes Redis' script cache. Use only against the disposable integration server. */
	public async flushScripts(): Promise<void> {
		const result = await this.command(['SCRIPT', 'FLUSH', 'SYNC']);

		if (result !== 'OK') throw new Error(`Unexpected SCRIPT FLUSH reply: ${String(result)}.`);
	}

	public async scriptLoad(script: string): Promise<string> {
		const result = await this.command(['SCRIPT', 'LOAD', script]);

		if (typeof result !== 'string') throw new Error('SCRIPT LOAD returned a non-string SHA.');

		return result;
	}

	public async evalsha(
		sha: string,
		keys: string[],
		args: (string | number)[],
	): Promise<unknown> {
		return await this.command(['EVALSHA', sha, keys.length, ...keys, ...args]);
	}

	public async get(key: string): Promise<string | null> {
		const result = await this.command(['GET', key]);

		if (result !== null && typeof result !== 'string') {
			throw new Error('GET returned an unexpected reply type.');
		}

		return result;
	}

	public async setWithExpiry(
		key: string,
		value: string,
		ttlMilliseconds: number,
	): Promise<unknown> {
		return await this.command(['SET', key, value, 'PX', ttlMilliseconds]);
	}

	public async exists(key: string): Promise<number> {
		const result = await this.command(['EXISTS', key]);

		if (typeof result !== 'number') {
			throw new Error('EXISTS returned an unexpected reply type.');
		}

		return result;
	}

	public async del(key: string): Promise<unknown> {
		return await this.command(['DEL', key]);
	}

	private async command(parts: readonly (string | number)[]): Promise<RedisReply> {
		const conn = this.endpoint.secure
			? await Deno.connectTls({ hostname: this.endpoint.hostname, port: this.endpoint.port })
			: await Deno.connect({ hostname: this.endpoint.hostname, port: this.endpoint.port });
		const reader = new RespReader(conn);

		try {
			if (this.endpoint.password !== undefined) {
				const authParts = this.endpoint.username === undefined
					? ['AUTH', this.endpoint.password] as const
					: ['AUTH', this.endpoint.username, this.endpoint.password] as const;

				await writeAll(conn, encodeCommand(authParts));

				const authReply = await reader.readReply();

				if (authReply !== 'OK') {
					throw new Error(`Unexpected Redis AUTH reply: ${String(authReply)}.`);
				}
			}

			if (this.endpoint.database !== 0) {
				await writeAll(conn, encodeCommand(['SELECT', this.endpoint.database]));

				const selectReply = await reader.readReply();

				if (selectReply !== 'OK') {
					throw new Error(`Unexpected Redis SELECT reply: ${String(selectReply)}.`);
				}
			}

			await writeAll(conn, encodeCommand(parts));

			return await reader.readReply();
		} finally {
			conn.close();
		}
	}
}
