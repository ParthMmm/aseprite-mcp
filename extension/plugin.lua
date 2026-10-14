-- WebSocket client for the aseprite-mcp daemon: pairing, the binary frame and the File > "Aseprite MCP..." window.

local PROTOCOL = 3
local PORT = 9123
local MIN_TOKEN = 16

-- JSON. Aseprite's own json.decode hands objects back as userdata, which ipairs/pairs cannot walk.

local function encode(value)
  local kind = type(value)
  if kind == "nil" then return "null" end
  if kind == "boolean" then return value and "true" or "false" end
  if kind == "number" then
    if math.type(value) == "integer" then return string.format("%d", value) end
    if value == math.floor(value) and math.abs(value) < 2 ^ 53 then return string.format("%d", math.tointeger(value)) end
    return string.format("%.17g", value)
  end
  if kind == "string" then
    return '"' .. value:gsub('[%c"\\]', function(ch)
      local named = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return named[ch] or string.format("\\u%04x", ch:byte())
    end) .. '"'
  end
  if kind == "table" then
    local parts = {}
    -- No reply ever carries an empty object, so an empty table is always an empty array.
    if next(value) == nil or value[1] ~= nil then
      for i = 1, #value do parts[i] = encode(value[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, v in pairs(value) do parts[#parts + 1] = encode(tostring(k)) .. ":" .. encode(v) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  error("cannot encode a " .. kind .. " as JSON", 0)
end

local LITERALS = { ["true"] = true, ["false"] = false }

local function decode(text)
  local pos = 1

  local function bad(what)
    error(string.format("bad JSON at byte %d: %s", pos, what), 0)
  end

  local function skip()
    pos = text:find("[^ \t\r\n]", pos) or #text + 1
  end

  local ESCAPES = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

  local function str()
    local out = {}
    pos = pos + 1
    while true do
      local stop = text:find('["\\]', pos) or bad("unterminated string")
      out[#out + 1] = text:sub(pos, stop - 1)
      pos = stop + 1
      if text:sub(stop, stop) == '"' then return table.concat(out) end
      local e = text:sub(pos, pos)
      if e == "u" then
        local code = tonumber(text:sub(pos + 1, pos + 4), 16) or bad("bad \\u escape")
        pos = pos + 5
        if code >= 0xd800 and code < 0xdc00 and text:sub(pos, pos + 1) == "\\u" then
          local low = tonumber(text:sub(pos + 2, pos + 5), 16) or bad("bad \\u escape")
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
          pos = pos + 6
        end
        out[#out + 1] = utf8.char(code)
      else
        out[#out + 1] = ESCAPES[e] or bad("bad escape")
        pos = pos + 1
      end
    end
  end

  local value

  local function list(close, item)
    pos = pos + 1
    skip()
    if text:sub(pos, pos) == close then
      pos = pos + 1
      return
    end
    while true do
      item()
      skip()
      local ch = text:sub(pos, pos)
      pos = pos + 1
      if ch == close then return end
      if ch ~= "," then bad("expected ',' or '" .. close .. "'") end
    end
  end

  function value()
    skip()
    local ch = text:sub(pos, pos)
    if ch == "{" then
      local obj = {}
      list("}", function()
        skip()
        if text:sub(pos, pos) ~= '"' then bad("expected a key") end
        local k = str()
        skip()
        if text:sub(pos, pos) ~= ":" then bad("expected ':'") end
        pos = pos + 1
        obj[k] = value()
      end)
      return obj
    elseif ch == "[" then
      local arr, n = {}, 0
      list("]", function()
        n = n + 1
        arr[n] = value()
      end)
      return arr
    elseif ch == '"' then
      return str()
    end
    for word, v in pairs(LITERALS) do
      if text:sub(pos, pos + #word - 1) == word then
        pos = pos + #word
        return v
      end
    end
    if text:sub(pos, pos + 3) == "null" then
      pos = pos + 4
      return nil
    end
    local num = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos) or bad("unexpected character")
    pos = pos + #num
    local n = tonumber(num) or bad("bad number")
    if num:find("[.eE]") then return n end
    return math.tointeger(n) or n
  end

  local result = value()
  skip()
  if pos <= #text then bad("trailing data") end
  return result
end

-- Binary frame: "AB", protocol, flags 0, u32 LE JSON length, JSON with "blobs": [lengths], then the blobs.

local function encodeFrame(msg, blobs)
  local lengths = {}
  for i, blob in ipairs(blobs) do lengths[i] = #blob end
  msg.blobs = lengths
  local json = encode(msg)
  msg.blobs = nil
  return "AB" .. string.pack("<BBI4", PROTOCOL, 0, #json) .. json .. table.concat(blobs)
end

local function decodeFrame(data)
  if #data < 8 then error("binary frame is shorter than its header", 0) end
  local magic, version, flags, size = string.unpack("<c2BBI4", data)
  if magic ~= "AB" then error("binary frame has a bad magic", 0) end
  if version ~= PROTOCOL then error("binary frame protocol " .. version .. ", expected " .. PROTOCOL, 0) end
  if flags ~= 0 then error("binary frame flags must be 0", 0) end
  local msg = decode(data:sub(9, 8 + size))
  local blobs, at = {}, 9 + size
  for i, n in ipairs(msg.blobs or {}) do
    blobs[i] = data:sub(at, at + n - 1)
    at = at + n
  end
  if at ~= #data + 1 then error("binary frame blob lengths do not match its size", 0) end
  msg.blobs = nil
  return msg, blobs
end

-- Connection state. `session` is replaced on every connect so late callbacks from an old socket are ignored.

local settings, handlers, sha256
local session
local statusText = "Not connected."
local window

local function showStatus(line)
  statusText = line
  if window then window:modify { id = "status", text = line } end
end

local function randomHex(n)
  local out = {}
  for i = 1, n do out[i] = string.format("%x", math.random(0, 15)) end
  return table.concat(out)
end

local function disconnect(text)
  local s = session
  session = nil
  if s then s.ws:close() end
  showStatus(text or "Not connected.")
end

local function reply(s, id, ok, payload, blobs)
  local msg = { id = id, ok = ok }
  if ok then msg.result = payload else msg.error = payload end
  if blobs and #blobs > 0 then
    s.ws:sendBinary(encodeFrame(msg, blobs))
  else
    s.ws:sendText(encode(msg))
  end
end

local pairing = {}

function pairing.challenge(s, msg)
  if PROTOCOL ~= msg.v then
    return disconnect(string.format("The daemon speaks protocol %s; this extension speaks %d. Update both.", tostring(msg.v), PROTOCOL))
  end
  s.serverNonce = tostring(msg.nonce)
  s.clientNonce = randomHex(32)
  s.ws:sendText(encode {
    type = "hello", v = PROTOCOL, nonce = s.clientNonce,
    mac = sha256.hmacHex(s.token, "client|" .. s.serverNonce .. "|" .. s.clientNonce),
    version = tostring(app.version), extension = handlers.VERSION,
  })
end

-- The server proves it holds the token too; until then nothing it sends is trusted.
function pairing.welcome(s, msg)
  if not s.clientNonce then return end
  if msg.mac ~= sha256.hmacHex(s.token, "server|" .. s.clientNonce .. "|" .. s.serverNonce) then
    return disconnect("The daemon on this port does not know the token. Disconnected.")
  end
  s.authed = true
  showStatus("Connected on port " .. s.port .. ".")
end

function pairing.denied()
  disconnect("The daemon rejected the token. Check it and connect again.")
end

local function onRequest(s, msg, blobs)
  if msg.id == nil or msg.cmd == nil then return end
  local ok, result, out = pcall(handlers.handle, msg.cmd, msg.args, blobs)
  if ok then
    reply(s, msg.id, true, result, out)
  else
    reply(s, msg.id, false, tostring(result))
  end
end

local function onReceive(s, kind, data)
  if session ~= s then return end
  if kind == WebSocketMessageType.OPEN then
    s.authed, s.clientNonce, s.serverNonce = false, nil, nil
    showStatus("Pairing...")
  elseif kind == WebSocketMessageType.CLOSE then
    s.authed = false
    showStatus("Waiting for the daemon on port " .. s.port .. "...")
  elseif kind == WebSocketMessageType.TEXT or kind == WebSocketMessageType.BINARY then
    local ok, msg, blobs = pcall(function()
      if kind == WebSocketMessageType.BINARY then return decodeFrame(data) end
      return decode(data), {}
    end)
    if not ok or type(msg) ~= "table" then return end
    if s.authed then
      onRequest(s, msg, blobs)
    elseif kind == WebSocketMessageType.TEXT then
      local step = pairing[msg.type]
      if step then step(s, msg) end
    end
  end
end

local function start()
  disconnect()
  local token, port = settings.token or "", tonumber(settings.port) or PORT
  if #token < MIN_TOKEN then
    return showStatus("Paste the token from `aseprite-mcp token` (" .. MIN_TOKEN .. "+ characters).")
  end
  local s = { token = token, port = port, authed = false }
  s.ws = WebSocket {
    url = "ws://127.0.0.1:" .. port,
    deflate = false, minreconnectwait = 1, maxreconnectwait = 10,
    onreceive = function(kind, data) onReceive(s, kind, data) end,
  }
  session = s
  s.ws:connect()
  showStatus("Connecting to port " .. port .. "...")
end

local function showWindow()
  if window then return end
  window = Dialog { title = "Aseprite MCP", onclose = function() window = nil end }
  window:entry { id = "token", label = "Token", text = settings.token or "" }
  window:number { id = "port", label = "Port", text = tostring(settings.port or PORT), decimals = 0 }
  window:label { id = "status", label = "Status", text = statusText }
  window:button {
    text = "Connect",
    onclick = function()
      settings.token = window.data.token
      settings.port = math.tointeger(window.data.port) or PORT
      start()
    end,
  }
  window:button { text = "Disconnect", onclick = function() disconnect() end }
  window:show { wait = false }
end

function init(p)
  settings = p.preferences
  handlers = dofile(app.fs.joinPath(p.path, "handlers.lua"))
  sha256 = dofile(app.fs.joinPath(p.path, "sha256.lua"))
  p:newCommand { id = "AsepriteMcpWindow", title = "Aseprite MCP...", group = "file_scripts", onclick = showWindow }
  if #(settings.token or "") >= MIN_TOKEN then start() end
end

function exit()
  disconnect()
end

-- Aseprite ignores a script's return value; tests load this file to reach the codecs.
return { encode = encode, decode = decode, encodeFrame = encodeFrame, decodeFrame = decodeFrame }
