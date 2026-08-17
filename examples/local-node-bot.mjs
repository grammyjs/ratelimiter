import { Bot } from '@grammyjs/grammy';
import { limit, Limiter } from '../dist/mod.js';
import { MemoryStore } from '../dist/storages.js';

const token = process.env.BOT_TOKEN;

if (!token) {
	throw new Error('BOT_TOKEN is required.');
}

const bot = new Bot(token);
const storage = new MemoryStore();

const limiter = new Limiter()
	.useStorage(storage)
	.fixedWindow({
		limit: 3,
		timeFrame: 10_000,
	})
	.limitFor('user')
	.withKeyPrefix('local-fixed-window')
	.onThrottled(async (ctx, info) => {
		await ctx.send(
			`THROTTLED — remaining=${info.remaining}, reset=${Math.ceil(info.reset / 1000)}s`,
		);
	});

bot.use(limit(limiter));

bot.on('message:text', async (ctx) => {
	await ctx.send(`ALLOWED — ${ctx.message.text}`);
});

console.log('Local Node test bot is running. Press Ctrl+C to stop.');
await bot.start();
