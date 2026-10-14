-- SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) on Lua 5.4 integers. Pairing needs only short
-- messages, so clarity wins over speed here.

local MASK = 0xffffffff

-- FIPS 180-4 defines the constants as the leading 32 fraction bits of square and cube roots of the
-- first primes, so they are derived here rather than typed in; the Node test checks known digests.
local function primes(n)
  local out, candidate = {}, 2
  while #out < n do
    local prime = true
    for _, p in ipairs(out) do
      if p * p > candidate then break end
      if candidate % p == 0 then prime = false break end
    end
    if prime then out[#out + 1] = candidate end
    candidate = candidate + 1
  end
  return out
end

local function fractionBits(x)
  return math.floor((x - math.floor(x)) * 2 ^ 32)
end

local P = primes(64)
local K, H0 = {}, {}
for i, p in ipairs(P) do K[i] = fractionBits(p ^ (1 / 3)) end
for i = 1, 8 do H0[i] = fractionBits(math.sqrt(P[i])) end

local function ror(v, bits)
  return ((v >> bits) | (v << (32 - bits))) & MASK
end

local function compress(H, block)
  local w = { string.unpack(">" .. string.rep("I4", 16), block) }
  w[17] = nil -- string.unpack also returns the next position
  for t = 17, 64 do
    local x, y = w[t - 15], w[t - 2]
    local s0 = ror(x, 7) ~ ror(x, 18) ~ (x >> 3)
    local s1 = ror(y, 17) ~ ror(y, 19) ~ (y >> 10)
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & MASK
  end
  local a, b, c, d, e, f, g, h = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
  for t = 1, 64 do
    local S1 = ror(e, 6) ~ ror(e, 11) ~ ror(e, 25)
    local ch = (e & f) ~ (~e & g)
    local t1 = (h + S1 + ch + K[t] + w[t]) & MASK
    local S0 = ror(a, 2) ~ ror(a, 13) ~ ror(a, 22)
    local maj = (a & b) ~ (a & c) ~ (b & c)
    local t2 = (S0 + maj) & MASK
    h, g, f, e = g, f, e, (d + t1) & MASK
    d, c, b, a = c, b, a, (t1 + t2) & MASK
  end
  H[1], H[2], H[3], H[4] = (H[1] + a) & MASK, (H[2] + b) & MASK, (H[3] + c) & MASK, (H[4] + d) & MASK
  H[5], H[6], H[7], H[8] = (H[5] + e) & MASK, (H[6] + f) & MASK, (H[7] + g) & MASK, (H[8] + h) & MASK
end

--- Raw 32-byte digest of `msg`.
local function digest(msg)
  local H = table.move(H0, 1, 8, 1, {})
  local pad = (55 - #msg) % 64
  local padded = msg .. "\x80" .. string.rep("\0", pad) .. string.pack(">I8", #msg * 8)
  for i = 1, #padded, 64 do
    compress(H, padded:sub(i, i + 63))
  end
  return string.pack(">I4I4I4I4I4I4I4I4", table.unpack(H))
end

local function tohex(raw)
  return (raw:gsub(".", function(ch) return string.format("%02x", ch:byte()) end))
end

local BLOCK = 64

--- Raw HMAC-SHA256 of `msg` under `key`.
local function hmac(key, msg)
  if #key > BLOCK then key = digest(key) end
  key = key .. string.rep("\0", BLOCK - #key)
  local inner = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x36) end)
  local outer = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x5c) end)
  return digest(outer .. digest(inner .. msg))
end

return {
  digest = digest,
  hex = function(msg) return tohex(digest(msg)) end,
  hmac = hmac,
  hmacHex = function(key, msg) return tohex(hmac(key, msg)) end,
}
