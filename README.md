[![Test Deno](https://github.com/Amir-Zouerami/rateLimiter/actions/workflows/deno.yml/badge.svg)](https://github.com/Amir-Zouerami/rateLimiter/actions/workflows/deno.yml)

# RatelimYter

<p align="center">
  <a href="https://github.com/Amir-Zouerami/rateLimiter">
    <img src="./RATELIMITER.svg" alt="ratelimiter Logo">
  </a>
</p>

## ❓ What does it do?
****
🔌 [rateLimiter](https://github.com/Amir-Zouerami/rateLimiter) is a rate-limiting middleware for Telegram bots made with [GrammY](https://grammy.dev/) or [Telegraf](https://github.com/telegraf/telegraf) bot frameworks. It rate limits users and stop them from spamming requests to your bot. You should note that this package **does not** rate limit the incoming requests from telegram servers, instead, it tracks the incoming requests by `from.id` and dismisses them on arrival so no further processing load is added to your servers.

Under normal circumstances, every request will be processed & answered by your bot which means spamming it will not be that difficult. Adding this middleware to your bot limits the number of requests a specific Telegram user can send during a certain time frame.

## 🔧 Customizability
This middleware exposes 5 customizable options:
- `timeFrame`: The time frame during which the requests will be monitored (defaults to `1000` ms).
- `limit`: The number of requests allowed within each `timeFrame` (defaults to `1`).
- `storageClient`: The type of storage to use for keeping track of users and their requests. It supports Redis as well. The default value is `MEMORY_STORE` which uses an in-memory Map, but you can also pass in a Redis client from [ioredis](https://github.com/luin/ioredis) or [redis](https://deno.land/x/redis) packages. Other redis drivers might work as well, but I have not tested them.
- `onLimitExceeded`: A function that describes what to do if the user exceeds the limit (ignores the extra requests by default).
- `keyGenerator`: A function that returns a unique key generated for each user (it uses `from.id` by default). This key is used to identify the user, therefore it should be unique and user specific.

> Note: You must have redis-server **2.6.0** and above on your server to use Redis storage client with rateLimiter. Older versions of Redis are not supported.

## 💻 Runtime Support
This plugin supports both [GrammY](https://grammy.dev/) and [Telegraf](https://telegraf.js.org/) bot frameworks, therefore Deno and Node are both supported. The following examples use [express](https://github.com/expressjs/express) but you can use rateLimiter with any grammy/telegraf supported framework or with no frameworks at all.

## 💻 How to Use
There are two ways of using rateLimiter:
- Accepting the defaults (Default Configuration).
- Passing a custom object containing your settings (Manual Configuration).

### ✅ Default Configuration

The following example uses [express](https://github.com/expressjs/express) as the webserver and [webhooks](https://grammy.dev/guide/deployment-types.html) to rate-limit users. This snippet demonstrates the easiest way of using rateLimiter which is accepting the default behavior:

``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimiter"

const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");

app.use(express.json());
bot.use(limit());

app.listen(3000, () => {
    bot.api.setWebhook("YOUR DOMAIN HERRE", { drop_pending_updates: true });
    console.log('The application is listening on port 3000!');
})
```

### ✅ Manual Configuration

As mentioned before, you can pass an `Options` object to the `limit()` function to alter rateLimiter's behaviors. In the following snippet, I have decided to use Redis as my storage option:

``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimiter"
import Redis from "ioredis";


const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");
const redis = new Redis();


app.use(express.json());
bot.use(limit({
    timeFrame: 2000,

    limit: 3,

    // "MEMORY_STORAGE" is the default mode. Therefore if you want to use Redis, do not pass storageClient at all.
    storageClient: redis,

    onLimitExceeded: ctx => { ctx?.reply("Please refrain from sending too many requests!") },

    // Note that the key should be a number in string format such as "123456789"
    keyGenerator: ctx => { return ctx.from?.id.toString() }
}));

app.listen(3000, () => {
    bot.api.setWebhook("YOUR DOMAIN HERRE", { drop_pending_updates: true });
    console.log('The application is listening on port 3000!');
})
```
As you can see in the above example, each user is allowed to send 3 requests every 2 seconds. If said user sends more requests, the bot replies with _Please refrain from sending too many requests_. That request will not travel further and dies immediately as we do not call `next()`.

> Note: To avoid flooding Telegram servers, `onLimitExceeded` is only executed once in every `timeFrame`.

Another use case would be limiting the incoming requests from a chat instead of a specific user:
``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimiter"

const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");

app.use(express.json());
bot.use(limit({
    keyGenerator: (ctx) => {
        if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
            // Note that the key should be a number in string format such as "123456789"
            return ctx.chat.id.toString();
        }
    }
}));

app.listen(3000, () => {
    bot.api.setWebhook("YOUR DOMAIN HERRE", { drop_pending_updates: true });
    console.log('The application is listening on port 3000!');
})
```
In this example, I have used `chat.id` as the unique key for rate-limiting.

## Acknowledgements
This package was heavily inspired by [telegraf-ratelimit](https://github.com/telegraf/telegraf-ratelimit).

## License
Distributed under the MIT License. See `LICENSE` for more information.
