import type {
	AtomicLimitConsumeResult,
	AtomicLimitLayerInput,
	FixedWindowIncrementResult,
	FixedWindowPreviewOptions,
	GcraConsumeOptions,
	GcraConsumeResult,
	IStorageEngine,
	LimitResult,
	PenaltyEscalationApplyOptions,
	PenaltyEscalationResult,
	PenaltyStrikeState,
	SlidingWindowConsumeOptions,
	SlidingWindowConsumeResult,
	TokenBucketConsumeOptions,
	TokenBucketConsumeResult,
} from '../types.ts';

/**
 * Minimal Redis client contract required by `RedisStore`.
 *
 * This adapter intentionally avoids depending on a specific Redis library.
 * Consumers can wrap ioredis, node-redis, deno-redis, or another client as long
 * as these operations preserve Redis command semantics.
 *
 * Redis Cluster adapters must ensure `scriptLoad()` and the corresponding
 * `evalsha()` calls are routed to a node that has the script loaded. Atomic
 * multi-key operations additionally require all participating keys to share a
 * Redis Cluster hash slot.
 */
export interface IRedisClient {
	/** Loads a Lua script into Redis and returns its SHA1 hash. */
	scriptLoad(script: string): Promise<string>;

	/**
	 * Executes a previously loaded Lua script.
	 *
	 * Array replies produced by Lua must be returned as JavaScript arrays with
	 * scalar items that can be converted to numbers/strings.
	 */
	evalsha(sha: string, keys: string[], args: (string | number)[]): Promise<unknown>;

	/** Retrieves a string value, or `null` if the key does not exist. */
	get(key: string): Promise<string | null>;

	/**
	 * Stores a string value with millisecond expiry.
	 *
	 * Typical adapters are:
	 * - ioredis: `set(key, value, 'PX', ttlMilliseconds)`
	 * - node-redis: `pSetEx(key, ttlMilliseconds, value)`
	 * - deno-redis: `set(key, value, { px: ttlMilliseconds })`
	 */
	setWithExpiry(key: string, value: string, ttlMilliseconds: number): Promise<unknown>;

	/** Returns `1` if a key exists and `0` otherwise. */
	exists(key: string): Promise<number>;

	/** Deletes a key. */
	del(key: string): Promise<unknown>;
}

const LUA_SCRIPT_ATOMIC_INCREMENT = `
local current = redis.call('INCR', KEYS[1])
local reset = redis.call('PTTL', KEYS[1])
if current == 1 or reset < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  reset = tonumber(ARGV[1])
end
if reset < 0 then
  reset = 0
end

return { current, reset }
`;

const LUA_SCRIPT_SLIDING_WINDOW = `
-- grammy-ratelimiter:sliding-window
redis.replicate_commands()

local limit = tonumber(ARGV[1])
local timeFrame = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local epsilon = 0.000000001

local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local windowStart = math.floor(now / timeFrame) * timeFrame
local elapsed = math.max(0, math.min(timeFrame, now - windowStart))

local currentCount = 0
local previousCount = 0
local rawState = redis.call('GET', KEYS[1])

if rawState then
  local state = cjson.decode(rawState)
  local storedStart = tonumber(state.windowStart)
  local storedCurrent = tonumber(state.currentCount)
  local storedPrevious = tonumber(state.previousCount)

  if storedStart == windowStart then
    currentCount = storedCurrent
    previousCount = storedPrevious
  elseif storedStart + timeFrame == windowStart then
    currentCount = 0
    previousCount = storedCurrent
  end
end

local previousWeight = (timeFrame - elapsed) / timeFrame
local usageBefore = currentCount + previousCount * previousWeight
local isAllowed = 0

if usageBefore + cost <= limit + epsilon then
  isAllowed = 1
  currentCount = currentCount + cost
end

local usageAfter = currentCount + previousCount * previousWeight
local remaining = math.max(0, math.floor((limit - usageAfter + epsilon) / cost))
local threshold = limit - cost
local reset = 0

if usageAfter > threshold + epsilon then
  local remainingInCurrentWindow = timeFrame - elapsed
  local resolved = false

  if previousCount > epsilon then
    local delayWithinCurrentWindow = (usageAfter - threshold) * timeFrame / previousCount
    if delayWithinCurrentWindow <= remainingInCurrentWindow + epsilon then
      reset = math.max(0, math.ceil(delayWithinCurrentWindow - epsilon))
      resolved = true
    end
  end

  if not resolved then
    if currentCount <= threshold + epsilon then
      reset = math.max(0, math.ceil(remainingInCurrentWindow))
    else
      local delayInNextWindow = (currentCount - threshold) * timeFrame / currentCount
      reset = math.max(0, math.ceil(remainingInCurrentWindow + delayInNextWindow - epsilon))
    end
  end
end

if isAllowed == 1 then
  redis.call(
    'PSETEX',
    KEYS[1],
    timeFrame * 2,
    cjson.encode({
      windowStart = windowStart,
      currentCount = currentCount,
      previousCount = previousCount
    })
  )
end

return { isAllowed, remaining, reset }
`;

const LUA_SCRIPT_TOKEN_BUCKET = `
-- grammy-ratelimiter:token-bucket
redis.replicate_commands()

local bucketSize = tonumber(ARGV[1])
local tokensPerInterval = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])

local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)

local tokens = bucketSize
local lastRefill = now
local rawState = redis.call('GET', KEYS[1])

if rawState then
  local state = cjson.decode(rawState)
  tokens = tonumber(state.tokens)
  lastRefill = tonumber(state.lastRefill)
end

tokens = math.min(bucketSize, math.max(0, tokens))
if lastRefill > now then
  lastRefill = now
end

local elapsed = now - lastRefill
if elapsed > 0 then
  local tokensToAdd = (elapsed / interval) * tokensPerInterval
  tokens = math.min(bucketSize, tokens + tokensToAdd)
  lastRefill = now
end

local isAllowed = 0
if tokens >= cost then
  isAllowed = 1
  tokens = tokens - cost
end

redis.call('PSETEX', KEYS[1], ttl, cjson.encode({ tokens = tokens, lastRefill = lastRefill }))

local reset = 0
if tokens < cost then
  reset = math.ceil((cost - tokens) * (interval / tokensPerInterval))
end

return { isAllowed, tostring(tokens), reset }
`;

const LUA_SCRIPT_GCRA = `
-- grammy-ratelimiter:gcra
redis.replicate_commands()

local rate = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local serverTime = redis.call('TIME')
local nowUs = tonumber(serverTime[1]) * 1000000 + tonumber(serverTime[2])
local emissionIntervalUs = (interval * 1000) / rate
local burstToleranceUs = (burst - 1) * emissionIntervalUs
local requestSpacingUs = cost * emissionIntervalUs
local requestThresholdUs = nowUs + burstToleranceUs - ((cost - 1) * emissionIntervalUs)

local theoreticalArrivalTimeUs = nowUs
local rawState = redis.call('GET', KEYS[1])
if rawState then
  theoreticalArrivalTimeUs = math.max(nowUs, tonumber(rawState))
end

local isAllowed = 0
local effectiveTheoreticalArrivalTimeUs = theoreticalArrivalTimeUs
if theoreticalArrivalTimeUs <= requestThresholdUs then
  isAllowed = 1
  effectiveTheoreticalArrivalTimeUs = theoreticalArrivalTimeUs + requestSpacingUs
  local ttl = math.max(1, math.ceil((effectiveTheoreticalArrivalTimeUs - nowUs) / 1000))
  redis.call('PSETEX', KEYS[1], ttl, tostring(effectiveTheoreticalArrivalTimeUs))
end

local remaining = 0
if effectiveTheoreticalArrivalTimeUs <= requestThresholdUs then
  remaining = math.floor(
    (requestThresholdUs - effectiveTheoreticalArrivalTimeUs) / requestSpacingUs
  ) + 1
end

local reset = math.max(
  0,
  math.ceil((effectiveTheoreticalArrivalTimeUs - requestThresholdUs) / 1000)
)

return { isAllowed, remaining, reset }
`;

const LUA_SCRIPT_REFUND_FIXED_WINDOW = `
-- grammy-ratelimiter:refund-fixed-window
local maxReset = tonumber(ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or ttl > maxReset then
  return 0
end

local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end

local value = tonumber(current)
if value <= 1 then
  redis.call('DEL', KEYS[1])
  return 1
end

redis.call('SET', KEYS[1], tostring(value - 1))
redis.call('PEXPIRE', KEYS[1], ttl)
return 1
`;

const LUA_SCRIPT_REFUND_SLIDING_WINDOW = `
-- grammy-ratelimiter:refund-sliding-window
redis.replicate_commands()

local timeFrame = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local epsilon = 0.000000001
local rawState = redis.call('GET', KEYS[1])
if not rawState then
  return 0
end

local ttl = redis.call('PTTL', KEYS[1])
local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local windowStart = math.floor(now / timeFrame) * timeFrame
local elapsed = math.max(0, math.min(timeFrame, now - windowStart))
local state = cjson.decode(rawState)
local storedStart = tonumber(state.windowStart)
local currentCount = 0
local previousCount = 0

if storedStart == windowStart then
  currentCount = tonumber(state.currentCount)
  previousCount = tonumber(state.previousCount)
elseif storedStart + timeFrame == windowStart then
  previousCount = tonumber(state.currentCount)
else
  redis.call('DEL', KEYS[1])
  return 1
end

local credit = cost
local currentRefund = math.min(currentCount, credit)
currentCount = math.max(0, currentCount - currentRefund)
credit = credit - currentRefund

local previousWeight = (timeFrame - elapsed) / timeFrame
if credit > epsilon and previousCount > epsilon and previousWeight > epsilon then
  local previousRefund = math.min(previousCount, credit / previousWeight)
  previousCount = math.max(0, previousCount - previousRefund)
end

if currentCount <= epsilon and previousCount <= epsilon then
  redis.call('DEL', KEYS[1])
  return 1
end

local encoded = cjson.encode({
  windowStart = windowStart,
  currentCount = currentCount,
  previousCount = previousCount
})
if ttl > 0 then
  redis.call('PSETEX', KEYS[1], ttl, encoded)
else
  redis.call('SET', KEYS[1], encoded)
end
return 1
`;

const LUA_SCRIPT_REFUND_TOKEN_BUCKET = `
-- grammy-ratelimiter:refund-token-bucket
redis.replicate_commands()

local bucketSize = tonumber(ARGV[1])
local tokensPerInterval = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local rawState = redis.call('GET', KEYS[1])
if not rawState then
  return 0
end

local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local state = cjson.decode(rawState)
local tokens = math.min(bucketSize, math.max(0, tonumber(state.tokens)))
local lastRefill = math.min(now, tonumber(state.lastRefill))
local elapsed = now - lastRefill
if elapsed > 0 then
  tokens = math.min(bucketSize, tokens + (elapsed / interval) * tokensPerInterval)
end

tokens = math.min(bucketSize, tokens + cost)
if tokens >= bucketSize - 0.000000001 then
  redis.call('DEL', KEYS[1])
  return 1
end

redis.call('PSETEX', KEYS[1], ttl, cjson.encode({ tokens = tokens, lastRefill = now }))
return 1
`;

const LUA_SCRIPT_REFUND_GCRA = `
-- grammy-ratelimiter:refund-gcra
redis.replicate_commands()

local rate = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local rawState = redis.call('GET', KEYS[1])
if not rawState then
  return 0
end

local serverTime = redis.call('TIME')
local nowUs = tonumber(serverTime[1]) * 1000000 + tonumber(serverTime[2])
local emissionIntervalUs = (interval * 1000) / rate
local requestSpacingUs = cost * emissionIntervalUs
local refunded = tonumber(rawState) - requestSpacingUs

if refunded <= nowUs then
  redis.call('DEL', KEYS[1])
  return 1
end

local ttl = math.max(1, math.ceil((refunded - nowUs) / 1000))
redis.call('PSETEX', KEYS[1], ttl, tostring(refunded))
return 1
`;

const LUA_SCRIPT_ATOMIC_LIMIT = `
-- grammy-ratelimiter:atomic-limit
redis.replicate_commands()

local layers = cjson.decode(ARGV[1])
local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local nowUs = tonumber(serverTime[1]) * 1000000 + tonumber(serverTime[2])
local epsilon = 0.000000001
local results = {}
local writes = {}

local function reject(outcome, index)
  -- cjson encodes an empty Lua table as '{}', so a rejection before any layer
  -- has produced a result (for example a penalty hit on the first layer) must
  -- force the results field back to a JSON array.
  local body = cjson.encode(results)
  if body == '{}' then body = '[]' end
  return '{"outcome":"' .. outcome .. '","index":' .. (index - 1) .. ',"results":' .. body .. '}'
end

for index, layer in ipairs(layers) do
  local penaltyKeyIndex = tonumber(layer.penaltyKeyIndex or 0)
  if penaltyKeyIndex > 0 and redis.call('EXISTS', KEYS[penaltyKeyIndex]) == 1 then
    return reject('penalty-hit', index)
  end

  local kind = layer.kind
  local keyIndex = tonumber(layer.keyIndex)
  local key = KEYS[keyIndex]
  local allowed = 0
  local remaining = 0
  local reset = 0
  local writeValue = nil
  local writeTtl = nil

  if kind == 'fixed-window' then
    local limit = tonumber(layer.limit)
    local timeFrame = tonumber(layer.timeFrame)
    local raw = redis.call('GET', key)
    local current = raw and tonumber(raw) or 0
    local projected = current + 1
    reset = raw and redis.call('PTTL', key) or timeFrame
    if reset < 0 then reset = timeFrame end
    if projected <= limit then allowed = 1 end
    remaining = math.max(0, limit - projected)
    if allowed == 1 then
      writeValue = tostring(projected)
      writeTtl = math.max(1, reset)
    end
  elseif kind == 'sliding-window' then
    local limit = tonumber(layer.limit)
    local timeFrame = tonumber(layer.timeFrame)
    local cost = tonumber(layer.cost)
    local windowStart = math.floor(now / timeFrame) * timeFrame
    local elapsed = math.max(0, math.min(timeFrame, now - windowStart))
    local currentCount = 0
    local previousCount = 0
    local raw = redis.call('GET', key)

    if raw then
      local state = cjson.decode(raw)
      local storedStart = tonumber(state.windowStart)
      local storedCurrent = tonumber(state.currentCount)
      local storedPrevious = tonumber(state.previousCount)
      if storedStart == windowStart then
        currentCount = storedCurrent
        previousCount = storedPrevious
      elseif storedStart + timeFrame == windowStart then
        previousCount = storedCurrent
      end
    end

    local previousWeight = (timeFrame - elapsed) / timeFrame
    local usageBefore = currentCount + previousCount * previousWeight
    if usageBefore + cost <= limit + epsilon then
      allowed = 1
      currentCount = currentCount + cost
    end

    local usageAfter = currentCount + previousCount * previousWeight
    remaining = math.max(0, math.floor((limit - usageAfter + epsilon) / cost))
    local threshold = limit - cost
    if usageAfter > threshold + epsilon then
      local remainingInCurrentWindow = timeFrame - elapsed
      local resolved = false
      if previousCount > epsilon then
        local delayWithinCurrentWindow = (usageAfter - threshold) * timeFrame / previousCount
        if delayWithinCurrentWindow <= remainingInCurrentWindow + epsilon then
          reset = math.max(0, math.ceil(delayWithinCurrentWindow - epsilon))
          resolved = true
        end
      end
      if not resolved then
        if currentCount <= threshold + epsilon then
          reset = math.max(0, math.ceil(remainingInCurrentWindow))
        else
          local delayInNextWindow = (currentCount - threshold) * timeFrame / currentCount
          reset = math.max(0, math.ceil(remainingInCurrentWindow + delayInNextWindow - epsilon))
        end
      end
    end

    if allowed == 1 then
      writeValue = cjson.encode({
        windowStart = windowStart,
        currentCount = currentCount,
        previousCount = previousCount
      })
      writeTtl = timeFrame * 2
    end
  elseif kind == 'token-bucket' then
    local bucketSize = tonumber(layer.bucketSize)
    local tokensPerInterval = tonumber(layer.tokensPerInterval)
    local interval = tonumber(layer.interval)
    local ttl = tonumber(layer.ttl)
    local cost = tonumber(layer.cost)
    local tokens = bucketSize
    local lastRefill = now
    local raw = redis.call('GET', key)

    if raw then
      local state = cjson.decode(raw)
      tokens = tonumber(state.tokens)
      lastRefill = tonumber(state.lastRefill)
    end

    tokens = math.min(bucketSize, math.max(0, tokens))
    if lastRefill > now then lastRefill = now end
    local elapsed = now - lastRefill
    if elapsed > 0 then
      tokens = math.min(bucketSize, tokens + (elapsed / interval) * tokensPerInterval)
      lastRefill = now
    end

    if tokens >= cost then
      allowed = 1
      tokens = tokens - cost
    end
    remaining = math.max(0, math.floor(tokens / cost))
    if tokens < cost then
      reset = math.ceil((cost - tokens) * (interval / tokensPerInterval))
    end

    if allowed == 1 then
      writeValue = cjson.encode({ tokens = tokens, lastRefill = lastRefill })
      writeTtl = ttl
    end
  elseif kind == 'gcra' then
    local rate = tonumber(layer.rate)
    local interval = tonumber(layer.interval)
    local burst = tonumber(layer.burst)
    local cost = tonumber(layer.cost)
    local emissionIntervalUs = (interval * 1000) / rate
    local burstToleranceUs = (burst - 1) * emissionIntervalUs
    local requestSpacingUs = cost * emissionIntervalUs
    local requestThresholdUs = nowUs + burstToleranceUs - ((cost - 1) * emissionIntervalUs)
    local theoreticalArrivalTimeUs = nowUs
    local raw = redis.call('GET', key)
    if raw then theoreticalArrivalTimeUs = math.max(nowUs, tonumber(raw)) end

    local effective = theoreticalArrivalTimeUs
    if theoreticalArrivalTimeUs <= requestThresholdUs then
      allowed = 1
      effective = theoreticalArrivalTimeUs + requestSpacingUs
    end
    if effective <= requestThresholdUs then
      remaining = math.floor((requestThresholdUs - effective) / requestSpacingUs) + 1
    end
    reset = math.max(0, math.ceil((effective - requestThresholdUs) / 1000))

    if allowed == 1 then
      writeValue = tostring(effective)
      writeTtl = math.max(1, math.ceil((effective - nowUs) / 1000))
    end
  else
    return redis.error_reply('grammy-ratelimiter: unsupported atomic limiter operation')
  end

  table.insert(results, { isAllowed = allowed, remaining = remaining, reset = reset })
  if allowed ~= 1 then
    return reject('throttled', index)
  end

  table.insert(writes, { keyIndex = keyIndex, value = writeValue, ttl = writeTtl })
end

for _, write in ipairs(writes) do
  redis.call('PSETEX', KEYS[write.keyIndex], math.max(1, math.ceil(write.ttl)), write.value)
end

return cjson.encode({ outcome = 'allowed', results = results })
`;

const LUA_SCRIPT_PREVIEW_FIXED_WINDOW = `
-- grammy-ratelimiter:preview-fixed-window
local limit = tonumber(ARGV[1])
local timeFrame = tonumber(ARGV[2])
local raw = redis.call('GET', KEYS[1])
local current = raw and tonumber(raw) or 0
local projected = current + 1
local reset = raw and redis.call('PTTL', KEYS[1]) or timeFrame
if reset < 0 then reset = timeFrame end
local allowed = projected <= limit and 1 or 0
local remaining = math.max(0, limit - projected)
return { allowed, remaining, reset }
`;

const LUA_SCRIPT_PREVIEW_SLIDING_WINDOW = `
-- grammy-ratelimiter:preview-sliding-window
local limit = tonumber(ARGV[1])
local timeFrame = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local epsilon = 0.000000001
local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local windowStart = math.floor(now / timeFrame) * timeFrame
local elapsed = math.max(0, math.min(timeFrame, now - windowStart))
local currentCount = 0
local previousCount = 0
local rawState = redis.call('GET', KEYS[1])
if rawState then
  local state = cjson.decode(rawState)
  local storedStart = tonumber(state.windowStart)
  if storedStart == windowStart then
    currentCount = tonumber(state.currentCount)
    previousCount = tonumber(state.previousCount)
  elseif storedStart + timeFrame == windowStart then
    previousCount = tonumber(state.currentCount)
  end
end
local previousWeight = (timeFrame - elapsed) / timeFrame
local usageBefore = currentCount + previousCount * previousWeight
local isAllowed = 0
if usageBefore + cost <= limit + epsilon then
  isAllowed = 1
  currentCount = currentCount + cost
end
local usageAfter = currentCount + previousCount * previousWeight
local remaining = math.max(0, math.floor((limit - usageAfter + epsilon) / cost))
local threshold = limit - cost
local reset = 0
if usageAfter > threshold + epsilon then
  local remainingInCurrentWindow = timeFrame - elapsed
  local resolved = false
  if previousCount > epsilon then
    local delayWithinCurrentWindow = (usageAfter - threshold) * timeFrame / previousCount
    if delayWithinCurrentWindow <= remainingInCurrentWindow + epsilon then
      reset = math.max(0, math.ceil(delayWithinCurrentWindow - epsilon))
      resolved = true
    end
  end
  if not resolved then
    if currentCount <= threshold + epsilon then
      reset = math.max(0, math.ceil(remainingInCurrentWindow))
    else
      local delayInNextWindow = (currentCount - threshold) * timeFrame / currentCount
      reset = math.max(0, math.ceil(remainingInCurrentWindow + delayInNextWindow - epsilon))
    end
  end
end
return { isAllowed, remaining, reset }
`;

const LUA_SCRIPT_PREVIEW_TOKEN_BUCKET = `
-- grammy-ratelimiter:preview-token-bucket
local bucketSize = tonumber(ARGV[1])
local tokensPerInterval = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local cost = tonumber(ARGV[5])
local serverTime = redis.call('TIME')
local now = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local tokens = bucketSize
local lastRefill = now
local rawState = redis.call('GET', KEYS[1])
if rawState then
  local state = cjson.decode(rawState)
  tokens = tonumber(state.tokens)
  lastRefill = tonumber(state.lastRefill)
end
tokens = math.min(bucketSize, math.max(0, tokens))
if lastRefill > now then lastRefill = now end
local elapsed = now - lastRefill
if elapsed > 0 then
  tokens = math.min(bucketSize, tokens + (elapsed / interval) * tokensPerInterval)
end
local isAllowed = 0
if tokens >= cost then
  isAllowed = 1
  tokens = tokens - cost
end
local reset = 0
if tokens < cost then reset = math.ceil((cost - tokens) * (interval / tokensPerInterval)) end
return { isAllowed, tostring(tokens), reset }
`;

const LUA_SCRIPT_PREVIEW_GCRA = `
-- grammy-ratelimiter:preview-gcra
local rate = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local serverTime = redis.call('TIME')
local nowUs = tonumber(serverTime[1]) * 1000000 + tonumber(serverTime[2])
local emissionIntervalUs = (interval * 1000) / rate
local burstToleranceUs = (burst - 1) * emissionIntervalUs
local requestSpacingUs = cost * emissionIntervalUs
local requestThresholdUs = nowUs + burstToleranceUs - ((cost - 1) * emissionIntervalUs)
local theoreticalArrivalTimeUs = nowUs
local rawState = redis.call('GET', KEYS[1])
if rawState then theoreticalArrivalTimeUs = math.max(nowUs, tonumber(rawState)) end
local isAllowed = 0
local effective = theoreticalArrivalTimeUs
if theoreticalArrivalTimeUs <= requestThresholdUs then
  isAllowed = 1
  effective = theoreticalArrivalTimeUs + requestSpacingUs
end
local remaining = 0
if effective <= requestThresholdUs then
  remaining = math.floor((requestThresholdUs - effective) / requestSpacingUs) + 1
end
local reset = math.max(0, math.ceil((effective - requestThresholdUs) / 1000))
return { isAllowed, remaining, reset }
`;

const LUA_SCRIPT_ESCALATING_PENALTY = `
-- grammy-ratelimiter:escalating-penalty
local basePenaltyTime = tonumber(ARGV[1])
local factor = tonumber(ARGV[2])
local maxPenaltyTime = tonumber(ARGV[3])
local resetAfter = tonumber(ARGV[4])

local strikes = 1
local previousPenaltyTime = nil
local rawState = redis.call('GET', KEYS[2])
if rawState then
  local state = cjson.decode(rawState)
  strikes = tonumber(state.strikes) + 1
  previousPenaltyTime = tonumber(state.lastPenaltyTime)
end

local penaltyTime = math.ceil(basePenaltyTime)
if previousPenaltyTime then
  local effectiveMax = math.max(basePenaltyTime, maxPenaltyTime, previousPenaltyTime)
  local scaled = previousPenaltyTime * factor
  penaltyTime = math.ceil(math.max(basePenaltyTime, math.min(effectiveMax, scaled)))
end

redis.call(
  'PSETEX',
  KEYS[2],
  resetAfter,
  cjson.encode({ strikes = strikes, lastPenaltyTime = penaltyTime })
)
redis.call('PSETEX', KEYS[1], penaltyTime, '1')

return { strikes, penaltyTime, resetAfter }
`;

const LUA_SCRIPT_PENALTY_STRIKE = `
-- grammy-ratelimiter:penalty-strike
local raw = redis.call('GET', KEYS[1])
if not raw then
  return { 0, 0, -1 }
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  return { 0, 0, -1 }
end
local state = cjson.decode(raw)
return { tonumber(state.strikes), tonumber(state.lastPenaltyTime), ttl }
`;

const LUA_SCRIPT_PENALTY_TTL = `
-- grammy-ratelimiter:penalty-ttl
local ttl = redis.call('PTTL', KEYS[1])
return ttl
`;

/** Returns whether an error indicates that Redis evicted/flushed a cached script. */
function isNoscriptError(error: unknown): boolean {
	return error instanceof Error && error.message.includes('NOSCRIPT');
}

/** Converts a Redis Lua array reply to a checked array. */
function requireArrayResult(result: unknown, operation: string): unknown[] {
	if (!Array.isArray(result)) {
		throw new Error(`RedisStore: ${operation} script returned a non-array result.`);
	}

	return result;
}

/** Converts a Redis scalar reply to a finite number. */
function requireFiniteNumber(value: unknown, operation: string): number {
	const numberValue = Number(value);

	if (!Number.isFinite(numberValue)) {
		throw new Error(`RedisStore: ${operation} script returned an invalid numeric value.`);
	}

	return numberValue;
}

/** Parses the common three-field limiter result returned by preview/GCRA scripts. */
function parseLimitResult(
	raw: unknown[],
	operation: string,
): LimitResult {
	if (raw.length < 3) {
		throw new Error(`RedisStore: ${operation} script returned an incomplete result.`);
	}

	const allowedValue = requireFiniteNumber(raw[0], operation);

	if (allowedValue !== 0 && allowedValue !== 1) {
		throw new Error(`RedisStore: ${operation} script returned an invalid allowed flag.`);
	}

	return {
		isAllowed: allowedValue === 1,
		remaining: Math.max(0, Math.floor(requireFiniteNumber(raw[1], operation))),
		reset: Math.max(0, requireFiniteNumber(raw[2], operation)),
	};
}

interface RedisAtomicResult {
	readonly isAllowed: number | boolean;
	readonly remaining: number;
	readonly reset: number;
}

interface RedisAtomicReply {
	readonly outcome: 'allowed' | 'penalty-hit' | 'throttled';
	readonly index?: number;
	readonly results: readonly RedisAtomicResult[];
}

/** Returns whether a value is a non-null object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Validates one limiter result decoded from the atomic-composite JSON reply. */
function isRedisAtomicResult(value: unknown): value is RedisAtomicResult {
	if (!isRecord(value)) {
		return false;
	}

	const { isAllowed, remaining, reset } = value;
	const hasValidAllowed = typeof isAllowed === 'boolean' || isAllowed === 0 || isAllowed === 1;

	return (
		hasValidAllowed &&
		typeof remaining === 'number' &&
		typeof reset === 'number'
	);
}

/** Validates the complete atomic-composite JSON reply before it reaches typed code. */
function isRedisAtomicReply(value: unknown): value is RedisAtomicReply {
	if (!isRecord(value)) {
		return false;
	}

	const { outcome, index, results } = value;
	const hasValidOutcome = outcome === 'allowed' || outcome === 'penalty-hit' ||
		outcome === 'throttled';
	const hasValidIndex = index === undefined || typeof index === 'number';

	return (
		hasValidOutcome &&
		hasValidIndex &&
		Array.isArray(results) &&
		results.every(isRedisAtomicResult)
	);
}

/** Parses and validates the JSON reply returned by the atomic composite script. */
function parseAtomicLimitResult(raw: unknown): AtomicLimitConsumeResult {
	if (typeof raw !== 'string') {
		throw new Error('RedisStore: atomic-limit script returned a non-string result.');
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('RedisStore: atomic-limit script returned invalid JSON.');
	}

	if (!isRedisAtomicReply(parsed)) {
		throw new Error('RedisStore: atomic-limit script returned an invalid result.');
	}

	const results = parsed.results.map((result) => {
		const allowed = result.isAllowed === true || result.isAllowed === 1;
		const remaining = result.remaining;
		const reset = result.reset;

		if (!Number.isFinite(remaining) || !Number.isFinite(reset)) {
			throw new Error('RedisStore: atomic-limit script returned invalid limiter metadata.');
		}

		return {
			isAllowed: allowed,
			remaining: Math.max(0, Math.floor(remaining)),
			reset: Math.max(0, reset),
		};
	});

	if (parsed.outcome === 'allowed') {
		return { outcome: 'allowed', results };
	}

	if (!Number.isInteger(parsed.index) || parsed.index === undefined || parsed.index < 0) {
		throw new Error('RedisStore: atomic-limit script returned an invalid rejection index.');
	}

	return { outcome: parsed.outcome, index: parsed.index, results };
}

/**
 * Shared Redis-backed storage engine.
 *
 * Fixed Window, Sliding Window, Token Bucket, GCRA, and escalating-penalty transitions
 * are implemented with Lua so their state changes remain atomic across concurrent
 * requests and multiple bot processes sharing the same Redis instance. Sliding
 * Window, Token Bucket, and GCRA use Redis server time to avoid application clock skew.
 */
export class RedisStore implements IStorageEngine {
	private readonly scriptShas = new Map<string, string>();
	private readonly client: IRedisClient;

	/**
	 * Creates a Redis-backed storage engine.
	 *
	 * @param client Consumer-provided Redis adapter implementing `IRedisClient`.
	 */
	constructor(client: IRedisClient) {
		this.client = client;
	}

	/** Retrieves JSON-serialized custom strategy state. */
	public async get<T>(key: string): Promise<T | undefined> {
		const state = await this.client.get(key);

		return state === null ? undefined : JSON.parse(state) as T;
	}

	/** Stores JSON-serializable custom strategy state with millisecond expiry. */
	public async set<T>(key: string, state: T, ttl: number): Promise<void> {
		const serialized = JSON.stringify(state);

		if (serialized === undefined) {
			throw new Error('RedisStore: custom strategy state must be JSON-serializable.');
		}

		await this.client.setWithExpiry(key, serialized, ttl);
	}

	/** Deletes a key. */
	public async delete(key: string): Promise<void> {
		await this.client.del(key);
	}

	/** Returns whether a penalty marker currently exists. */
	public async checkPenalty(key: string): Promise<boolean> {
		return await this.client.exists(key) === 1;
	}

	/** Stores a penalty marker with millisecond expiry. */
	public async setPenalty(key: string, ttl: number): Promise<void> {
		await this.client.setWithExpiry(key, '1', ttl);
	}

	/** Atomically increments strike state and persists the resulting escalated penalty. */
	public async applyEscalatingPenalty(
		penaltyKey: string,
		strikeKey: string,
		options: PenaltyEscalationApplyOptions,
	): Promise<PenaltyEscalationResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_ESCALATING_PENALTY, [penaltyKey, strikeKey], [
				options.basePenaltyTime,
				options.factor,
				options.maxPenaltyTime,
				options.resetAfter,
			]),
			'escalating-penalty',
		);

		if (raw.length < 3) {
			throw new Error('RedisStore: escalating-penalty script returned an incomplete result.');
		}

		return {
			strikes: Math.max(1, Math.floor(requireFiniteNumber(raw[0], 'escalating-penalty'))),
			penaltyTime: Math.max(1, Math.ceil(requireFiniteNumber(raw[1], 'escalating-penalty'))),
			reset: Math.max(0, requireFiniteNumber(raw[2], 'escalating-penalty')),
		};
	}

	/** Returns current escalation strike state without mutating it. */
	public async getPenaltyStrikeState(strikeKey: string): Promise<PenaltyStrikeState | undefined> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_PENALTY_STRIKE, [strikeKey], []),
			'penalty-strike',
		);

		if (raw.length < 3) {
			throw new Error('RedisStore: penalty-strike script returned an incomplete result.');
		}

		const strikes = requireFiniteNumber(raw[0], 'penalty-strike');
		const lastPenaltyTime = requireFiniteNumber(raw[1], 'penalty-strike');
		const reset = requireFiniteNumber(raw[2], 'penalty-strike');

		return strikes <= 0 || reset < 0 ? undefined : {
			strikes: Math.floor(strikes),
			lastPenaltyTime: Math.max(1, Math.ceil(lastPenaltyTime)),
			reset: Math.max(0, reset),
		};
	}

	/**
	 * Atomically increments a fixed-window counter and returns its remaining TTL.
	 */
	public async increment(key: string, ttl: number): Promise<FixedWindowIncrementResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_ATOMIC_INCREMENT, [key], [ttl]),
			'fixed-window',
		);

		if (raw.length < 2) {
			throw new Error('RedisStore: fixed-window script returned an incomplete result.');
		}

		return {
			value: requireFiniteNumber(raw[0], 'fixed-window'),
			reset: Math.max(0, requireFiniteNumber(raw[1], 'fixed-window')),
		};
	}

	/** Restores one request only when the original Fixed Window is still active. */
	public async refundFixedWindow(key: string, maxReset: number): Promise<boolean> {
		const raw = await this.evalScript(LUA_SCRIPT_REFUND_FIXED_WINDOW, [key], [maxReset]);

		return requireFiniteNumber(raw, 'fixed-window-refund') === 1;
	}

	/**
	 * Evaluates and commits a multi-rule limiter chain in one Redis Lua transaction.
	 *
	 * Every participating strategy key—and any penalty keys supplied with the
	 * layers—must be addressable by one Redis script. On Redis Cluster this means
	 * using prefixes with a shared hash tag, for example `{bot}:user` and
	 * `{bot}:global`, so all keys map to one hash slot.
	 */
	public async consumeAtomicLimit(
		layers: readonly AtomicLimitLayerInput[],
	): Promise<AtomicLimitConsumeResult> {
		const keys: string[] = [];
		const seenStrategyKeys = new Set<string>();
		const encoded = layers.map((layer) => {
			if (seenStrategyKeys.has(layer.operation.key)) {
				throw new Error(
					`RedisStore: atomic limiter strategy keys must be unique; duplicate '${layer.operation.key}'.`,
				);
			}

			seenStrategyKeys.add(layer.operation.key);

			keys.push(layer.operation.key);

			const keyIndex = keys.length;
			let penaltyKeyIndex = 0;

			if (layer.penaltyKey !== undefined) {
				keys.push(layer.penaltyKey);
				penaltyKeyIndex = keys.length;
			}

			switch (layer.operation.kind) {
				case 'fixed-window':
					return {
						kind: layer.operation.kind,
						keyIndex,
						penaltyKeyIndex,
						limit: layer.operation.limit,
						timeFrame: layer.operation.timeFrame,
					};
				case 'sliding-window':
					return {
						kind: layer.operation.kind,
						keyIndex,
						penaltyKeyIndex,
						...layer.operation.options,
					};
				case 'token-bucket':
					return {
						kind: layer.operation.kind,
						keyIndex,
						penaltyKeyIndex,
						...layer.operation.options,
					};
				case 'gcra':
					return {
						kind: layer.operation.kind,
						keyIndex,
						penaltyKeyIndex,
						...layer.operation.options,
					};
			}
		});

		return parseAtomicLimitResult(
			await this.evalScript(LUA_SCRIPT_ATOMIC_LIMIT, keys, [JSON.stringify(encoded)]),
		);
	}

	/** Previews the next Fixed Window decision without incrementing its counter. */
	public async previewFixedWindow(
		key: string,
		options: FixedWindowPreviewOptions,
	): Promise<LimitResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_PREVIEW_FIXED_WINDOW, [key], [
				options.limit,
				options.timeFrame,
			]),
			'fixed-window-preview',
		);

		return parseLimitResult(raw, 'fixed-window-preview');
	}

	/**
	 * Atomically evaluates a bounded-memory Sliding Window Counter using Redis server time.
	 *
	 * Denied requests do not consume capacity or extend the stored state's TTL.
	 */
	public async consumeSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_SLIDING_WINDOW, [key], [
				options.limit,
				options.timeFrame,
				options.cost,
			]),
			'sliding-window',
		);

		if (raw.length < 3) {
			throw new Error('RedisStore: sliding-window script returned an incomplete result.');
		}

		const allowedValue = requireFiniteNumber(raw[0], 'sliding-window');

		if (allowedValue !== 0 && allowedValue !== 1) {
			throw new Error('RedisStore: sliding-window script returned an invalid allowed flag.');
		}

		return {
			isAllowed: allowedValue === 1,
			remaining: Math.max(0, Math.floor(requireFiniteNumber(raw[1], 'sliding-window'))),
			reset: Math.max(0, requireFiniteNumber(raw[2], 'sliding-window')),
		};
	}

	/** Restores one configured request cost to current Sliding Window capacity. */
	public async refundSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<void> {
		await this.evalScript(LUA_SCRIPT_REFUND_SLIDING_WINDOW, [key], [
			options.timeFrame,
			options.cost,
		]);
	}

	/** Previews the next Sliding Window decision without consuming capacity. */
	public async previewSlidingWindow(
		key: string,
		options: SlidingWindowConsumeOptions,
	): Promise<SlidingWindowConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_PREVIEW_SLIDING_WINDOW, [key], [
				options.limit,
				options.timeFrame,
				options.cost,
			]),
			'sliding-window-preview',
		);

		return parseLimitResult(raw, 'sliding-window-preview');
	}

	/**
	 * Atomically refills a token bucket and consumes the requested cost using Redis server time.
	 */
	public async consumeTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_TOKEN_BUCKET, [key], [
				options.bucketSize,
				options.tokensPerInterval,
				options.interval,
				options.ttl,
				options.cost,
			]),
			'token-bucket',
		);

		if (raw.length < 3) {
			throw new Error('RedisStore: token-bucket script returned an incomplete result.');
		}

		const allowedValue = requireFiniteNumber(raw[0], 'token-bucket');

		if (allowedValue !== 0 && allowedValue !== 1) {
			throw new Error('RedisStore: token-bucket script returned an invalid allowed flag.');
		}

		return {
			isAllowed: allowedValue === 1,
			tokens: requireFiniteNumber(raw[1], 'token-bucket'),
			reset: Math.max(0, requireFiniteNumber(raw[2], 'token-bucket')),
		};
	}

	/** Refills current Token Bucket state and restores one configured request cost. */
	public async refundTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<void> {
		await this.evalScript(LUA_SCRIPT_REFUND_TOKEN_BUCKET, [key], [
			options.bucketSize,
			options.tokensPerInterval,
			options.interval,
			options.ttl,
			options.cost,
		]);
	}

	/** Previews the next Token Bucket decision without consuming tokens. */
	public async previewTokenBucket(
		key: string,
		options: TokenBucketConsumeOptions,
	): Promise<TokenBucketConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_PREVIEW_TOKEN_BUCKET, [key], [
				options.bucketSize,
				options.tokensPerInterval,
				options.interval,
				options.ttl,
				options.cost,
			]),
			'token-bucket-preview',
		);

		if (raw.length < 3) {
			throw new Error(
				'RedisStore: token-bucket preview script returned an incomplete result.',
			);
		}

		const allowedValue = requireFiniteNumber(raw[0], 'token-bucket-preview');

		return {
			isAllowed: allowedValue === 1,
			tokens: requireFiniteNumber(raw[1], 'token-bucket-preview'),
			reset: Math.max(0, requireFiniteNumber(raw[2], 'token-bucket-preview')),
		};
	}

	/**
	 * Atomically evaluates GCRA using Redis server time.
	 *
	 * Denied requests do not mutate the stored theoretical-arrival timestamp or
	 * extend its TTL.
	 */
	public async consumeGcra(
		key: string,
		options: GcraConsumeOptions,
	): Promise<GcraConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_GCRA, [key], [
				options.rate,
				options.interval,
				options.burst,
				options.cost,
			]),
			'gcra',
		);

		if (raw.length < 3) {
			throw new Error('RedisStore: GCRA script returned an incomplete result.');
		}

		const allowedValue = requireFiniteNumber(raw[0], 'gcra');

		if (allowedValue !== 0 && allowedValue !== 1) {
			throw new Error('RedisStore: GCRA script returned an invalid allowed flag.');
		}

		return {
			isAllowed: allowedValue === 1,
			remaining: Math.max(0, Math.floor(requireFiniteNumber(raw[1], 'gcra'))),
			reset: Math.max(0, requireFiniteNumber(raw[2], 'gcra')),
		};
	}

	/** Restores one configured request cost to the current GCRA schedule. */
	public async refundGcra(key: string, options: GcraConsumeOptions): Promise<void> {
		await this.evalScript(LUA_SCRIPT_REFUND_GCRA, [key], [
			options.rate,
			options.interval,
			options.cost,
		]);
	}

	/** Previews the next GCRA decision without advancing its virtual schedule. */
	public async previewGcra(
		key: string,
		options: GcraConsumeOptions,
	): Promise<GcraConsumeResult> {
		const raw = requireArrayResult(
			await this.evalScript(LUA_SCRIPT_PREVIEW_GCRA, [key], [
				options.rate,
				options.interval,
				options.burst,
				options.cost,
			]),
			'gcra-preview',
		);

		return parseLimitResult(raw, 'gcra-preview');
	}

	/** Returns the remaining lifetime of an active penalty marker. */
	public async getPenaltyTtl(key: string): Promise<number | undefined> {
		const ttl = requireFiniteNumber(
			await this.evalScript(LUA_SCRIPT_PENALTY_TTL, [key], []),
			'penalty-ttl',
		);

		return ttl < 0 ? undefined : Math.max(0, ttl);
	}

	/**
	 * Evaluates a Lua script with SHA caching and transparently reloads it after
	 * Redis returns `NOSCRIPT` (for example after a cache flush or restart).
	 */
	private async evalScript(
		script: string,
		keys: string[],
		args: (string | number)[],
	): Promise<unknown> {
		let sha = this.scriptShas.get(script);

		if (!sha) {
			sha = await this.client.scriptLoad(script);
			this.scriptShas.set(script, sha);
		}

		try {
			return await this.client.evalsha(sha, keys, args);
		} catch (error) {
			if (!isNoscriptError(error)) {
				throw error;
			}

			const reloadedSha = await this.client.scriptLoad(script);

			this.scriptShas.set(script, reloadedSha);

			return await this.client.evalsha(reloadedSha, keys, args);
		}
	}
}
