# RatelimYter

<p align="center">
  <a href="https://github.com/Amir-Zouerami/ratelimYter-grammY">
    <img src="./RATE_LIMYTER.jpg" alt="ratelimYter Logo">
  </a>
</p>

## ❓ What does it do?

🔌 [RatelimYter](https://github.com/Amir-Zouerami/ratelimYter-grammY) is a rate-limiting middleware for [GrammY](https://grammy.dev/) Telegram bot framework to rate-limit users and stop them from spamming requests to your bot. You should note that this package **does not** rate limit the incoming requests from telegram servers, instead, it tracks the incoming requests by `from.id` and dismisses them on arrival so no further processing load is added to your servers.

**TLDR**: Under normal circumstances, every request will be processed & answered by your bot which means spamming it will not be that difficult. Adding this middleware to your bot limits the number of requests a specific Telegram user can send during a certain time frame.

## 🔧 Customizability
This middleware exposes 4 customizable options:
- `timeFrame`: The time frame during which the requests will be monitored (defaults to 1000 ms).
- `limit`: The number of requests allowed in each `timeFrame` (defaults to 1).
- `onLimitExceeded`: A function that describes what to do if the user exceeds the limit (ignores the extra requests by default).
- `keyGenerator`: A function that describes a unique key generated for each user (it uses `from.id` by default).

## 💻 How to Use
The following example uses [express](https://github.com/expressjs/express) as the web server and [webhooks](https://grammy.dev/guide/deployment-types.html) to rate-limit users:

``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimyter-grammy"

const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");

app.use(express.json());
bot.use(limit());

app.listen(3000, () => {
    bot.api.setWebhook("YOUR DOMAIN HERRE", { drop_pending_updates: true });
    console.log('The application is listening on port 3000!');
})
```
This code demonstrates the easiest way of usign RatelimYter-grammY which is accepting the default behavior, but as mentioned before you can pass arguments to the `limit()` function to alter these behaviors:
``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimyter-grammy"

const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");

app.use(express.json());
bot.use(limit({
    timeFrame: 2000,
    limit: 3,
    onLimitExceeded: (ctx, next) => {
        ctx.reply("Please refrain from sending too many requests.")
    }
}));

app.listen(3000, () => {
    bot.api.setWebhook("YOUR DOMAIN HERRE", { drop_pending_updates: true });
    console.log('The application is listening on port 3000!');
})
```
As you can see in the above example, each user is allowed to send 3 requests every 2 seconds. If said user sends more requests, the bot replies with _Please refrain from sending too many requests_. That request will not travel further and dies immediately as we do not call `next()` in `onLimitExceeded`. Although sending a message to spammers might not be a wise decision since you'll be basically spamming telegram servers with your bot. _This example was for demonstration purposes only_.

Another use case would be limiting the incoming requests from a chat instead of a specific user:
``` typescript
import express from "express";
import { Bot } from "grammy";
import { limit } from "ratelimyter-grammy"

const app = express();
const bot = new Bot("YOUR BOT TOKEN HERE");

app.use(express.json());
bot.use(limit({
    timeFrame: 2000,
    limit: 3,
    onLimitExceeded: (ctx, next) => {
        ctx.reply("Please refrain from sending too many requests.")
    },
    keyGenerator: (ctx) => {
        if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
            return ctx.chat.id
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