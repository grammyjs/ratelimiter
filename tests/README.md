# Test Architecture

The test suite is organized by the contract being protected rather than by the source-file layout.

- `runtime/` contains observable runtime behavior tests.
- `contracts/` contains reusable backend contracts. Every storage engine must pass the same
  `IStorageEngine` contract.
- `types/` contains compile-time public API contracts. These are checked with `deno check` and are
  deliberately not counted as runtime tests.
- `support/` contains deterministic clocks, storage doubles, and context/test fixtures. Test doubles
  are used only where the collaborator itself is not the subject under test.
- `node/` validates the generated Node.js package produced by `deno2node`.
- `integration/` contains opt-in tests against external services and is not part of the fast default
  suite.

## Principles

1. Test externally meaningful behavior and state transitions.
2. Keep type compatibility separate from runtime coverage.
3. Run storage implementations through one shared behavioral contract.
4. Use deterministic time instead of real sleeps for unit/contract tests.
5. Test concurrency at the storage boundary where atomicity is guaranteed.
6. Keep Redis simulation and real Redis integration distinct: the simulator protects adapter
   behavior quickly; the opt-in real-server suite validates Lua, Redis time, TTLs, script-cache
   recovery, rollback, and cross-connection concurrency.
7. Add a regression test only when it protects a documented contract or a bug that could
   realistically return.

## Real Redis integration

The real Redis suite is intentionally separate from `deno task ok`. It uses a dependency-free RESP
client in `tests/support/real_redis_client.ts`, so production and test dependencies do not gain a
Redis client package. The suite verifies the actual Lua programs, server-time behavior, TTLs,
`NOSCRIPT` recovery, escalating penalties, atomic rollback, cross-store state sharing, and
concurrent atomic admission.

Point the suite at a **disposable** Redis instance because one test executes `SCRIPT FLUSH`:

```sh
docker run --rm --name ratelimiter-redis-test -p 6379:6379 redis:8-alpine
RATELIMITER_REDIS_URL=redis://127.0.0.1:6379 deno task test:redis
```

`redis://` and `rediss://` URLs are supported, including username/password and database selection.
For release CI, run this task against at least one current Redis 7.x instance and one current Redis
8.x instance. Keep it as a separate job from the deterministic unit/contract suite.

## Storage failure tests

Storage failures are tagged at the storage-call boundary before they reach a strategy. This
distinction is intentional: fail-open behavior may suppress a backend outage, but it must never
suppress an exception thrown by strategy or application code. Runtime tests therefore cover both
storage failures and non-storage strategy failures explicitly.

## Sliding Window coverage

Sliding Window contract tests protect boundary smoothing, weighted costs, recovery as the previous
bucket decays, and concurrent admission. Strategy tests verify the exact storage call, middleware
tests cover context-derived limits/costs and runtime validation, and type tests keep the static
`timeFrame` contract explicit. Memory and simulated Redis both run the shared storage contract; the
opt-in real-Redis suite executes the Lua implementation against Redis server time.

## Token Bucket coverage

Token Bucket contract tests cover default one-token requests, weighted token costs, fractional
refill, and concurrent consumption. Middleware tests separately verify that context-derived bucket
capacity, refill rate, interval, and request cost are resolved before storage is called. This keeps
storage atomicity tests distinct from builder/middleware configuration tests.

## GCRA coverage

GCRA storage contract tests assert initial burst capacity, smooth recovery, weighted costs, and
concurrent admission. Strategy tests verify the exact storage collaboration, while middleware type
and runtime tests cover context-derived rate, interval, burst, and cost. The Redis simulator keeps
these tests deterministic; the opt-in real-Redis suite executes the real Lua program against Redis
server time.

## Penalty namespace coverage

Penalty tests protect rule isolation as well as explicit sharing. By default a rule derives its
penalty namespace from its final `keyPrefix`, so one limiter cannot mute another limiter that uses
the same entity key. Supplying `penaltyKeyPrefix` explicitly remains an opt-in escape hatch for a
custom or intentionally shared penalty namespace.

Escalation coverage verifies geometric strike progression, maximum-duration capping, inactivity
reset, active-penalty hits not adding strikes, independent `clearPenalty()`/`clearStrikes()`
controls, and atomic strike increments in both MemoryStore and simulated Redis.

## Composite-limit coverage

## Atomic composition coverage

`limitAllAtomic()` is covered separately from sequential `limitAll()`. The suite verifies that all
layers commit together, later throttles and active penalties leave earlier strategy state untouched,
filters still bypass, incompatible stores/modes are rejected, and Memory/simulated-Redis preserve
the same all-or-nothing behavior under concurrency. Node package tests also exercise the exported
API after `deno2node` generation.

`limitAll()` is tested as an ordered middleware chain rather than as a second limiter engine. Tests
protect the important cross-rule contracts: every layer must allow before downstream middleware
runs, bypasses continue to later layers, the first rejection short-circuits later storage work, and
capacity consumed by an earlier layer is intentionally not rolled back when a later layer rejects.
This mirrors the documented semantics for independent or distributed stores.

## Metrics-hook coverage

Metric tests verify that the hook is opt-in, preserves rule names and enabled identity metadata,
distinguishes middleware/manual-consume/atomic-composite sources, and reports non-negative monotonic
durations. Refund tests separately protect awaited versus best-effort sources and refund outcomes so
metrics adapters do not need to infer lifecycle state from unrelated events.

## Observe-only coverage

Observe-only tests protect three separate contracts: blocking decisions still call downstream
middleware, dry-run state lives in an isolated shadow namespace, and enforcement callbacks/penalty
markers are not produced by the shadow rule. The structured `decision` event is tested separately
from legacy fine-grained events so telemetry can evolve without changing enforcement semantics.
Storage-failure tests also verify that observe-only mode measures fail-closed outcomes without
turning the default `throw` policy into silent error suppression.

## State-control coverage

`tests/runtime/control/limiter_control.test.ts` verifies that the middleware returned by `limit()`
can inspect limiter state without consuming capacity, reset strategy state independently from
penalties, clear active penalties independently from escalation strikes, clear strike history
explicitly, and report unsupported custom strategy previews. Built-in Memory/Redis preview semantics
are shared through `tests/contracts/inspection_contract.ts`.

## Rich-metadata coverage

Metadata tests verify that identity data is absent by default, `withMetadata()` adds only stable
Telegram user/chat IDs, custom resolver fields remain nested and type-inferred, and metadata is
propagated through normal decisions, `inspect()`, and atomic composites. A dedicated hot-path test
also verifies that custom metadata resolution does not run when middleware has no `decision`
listener.

## Manual-consumption coverage

`tests/runtime/control/manual_consume.test.ts` verifies that `consume(ctx)` uses the same
enforcement path as middleware without calling grammY `next()`. Coverage includes normal
admission/throttling, filter bypasses, observe-only control flow, penalties and strike escalation,
storage-failure policy, `onThrottled()`/decision events, named rich metadata, and preservation of
lazy metadata resolution on the ordinary middleware hot path. Type tests protect custom metadata
inference, and Node package tests exercise the generated `deno2node` API.

## Refund coverage

`tests/runtime/control/limiter_refund.test.ts` verifies single-use receipts, limiter-instance
ownership, retry after awaited refund failure, detached best-effort failure containment, and
capacity restoration for all built-in strategies. The shared storage contract exercises MemoryStore
and simulated Redis refund primitives, while the opt-in real Redis suite executes the refund Lua
scripts against an actual Redis server. Node package tests protect the generated API surface.

## Cooldown coverage

`tests/runtime/control/cooldown.test.ts` protects cooldown as a real minimum interval rather than a
one-request Fixed Window. Coverage includes exact boundary recovery, context-resolved durations,
eager static validation, and inherited GCRA reset/refund behavior. Node package tests exercise the
same high-level API after `deno2node` generation. Because cooldown is implemented through GCRA, its
Memory/Redis atomicity and Redis server-time behavior remain covered by the existing GCRA storage
and real-Redis suites instead of duplicating backend tests.

## Scope-preset coverage

Builder tests verify that `Limiter.perUser()`, `Limiter.perChat()`, `Limiter.perUserPerChat()`, and
`Limiter.global()` produce the same entity-key semantics as their explicit `limitFor(...)`
equivalents. Type tests preserve flavored grammY context inference, while the Node package test
checks the generated package exposes the factories without adding hidden strategy or storage policy.

### Reusable preset coverage

Reusable limiter presets are covered for fresh-builder isolation, rejection of recycled mutable
builders, flavored-context/rich-metadata inference, and generated Node package exports.

### Explicit diagnostics

Diagnostics coverage verifies that `diagnose()` is non-consuming, does not emit normal limiter
telemetry, preserves named-rule and opt-in identity metadata, distinguishes enforce/observe
continuation semantics, reports active penalties and unsupported custom previews, and identifies
blocking layers in both sequential and atomic composites.
