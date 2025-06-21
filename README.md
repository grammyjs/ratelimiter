[![Test and Build](https://github.com/Amir-Zouerami/ratelimiter/actions/workflows/test.yml/badge.svg)](https://github.com/Amir-Zouerami/ratelimiter/actions/workflows/test.yml)

# Rate Limit Users (`ratelimiter`)

`ratelimiter` is an advanced and flexible middleware for the grammY framework, designed to protect
Telegram bots from spam and resource abuse.

<p align="center">
  <a href="https://github.com/grammyjs/ratelimiter">
    <img src="./grammy-ratelimiter-cover.png" alt="grammY rate limiter cover">
  </a>
</p>

At its core, `ratelimiter` acts as a configurable gatekeeper for incoming updates. It allows
developers to define precise rules for how many messages a user or chat (or any arbitrary entity)
can send in a given period, ensuring the bot remains responsive and server resources are protected
from overload.

The plugin inspects each incoming message, identifies its source, and decides if it should be
processed or dismissed based on the rules you set.

> **For more information and how-to instructions, please visit**
> [**the official grammY ratelimiter documentation.**](https://grammy.dev/plugins/ratelimiter)

## License

Distributed under the MIT License. See `LICENSE` for more information.
