-- Runs inside `aseprite -b`. Params: ext (extension dir), dir (scratch dir), out (result JSON path).
-- aseprite.test.ts drives it and turns every case into a Node subtest.

local ext, dir = app.params.ext, app.params.dir
local function module(name) return dofile(app.fs.joinPath(ext, name .. ".lua")) end
local H, wire, sha256 = module("handlers"), module("plugin"), module("sha256")

local function call(cmd, args, blobs)
  return H.handle(cmd, args or {}, blobs or {})
end

local function check(cond, msg)
  if not cond then error(msg, 2) end
end

local function same(a, b, where)
  where = where or "value"
  if type(a) ~= "table" or type(b) ~= "table" then
    check(a == b, where .. ": " .. tostring(a) .. " ~= " .. tostring(b))
    return
  end
  for k, v in pairs(a) do same(v, b[k], where .. "." .. tostring(k)) end
  for k in pairs(b) do check(a[k] ~= nil, where .. "." .. tostring(k) .. " only on the right") end
end

local function snap(ref)
  local result, blobs = call("snapshot", { sprite = ref })
  return { result = result, blobs = blobs }
end

local function celBytes(s, layer, frame)
  for _, c in ipairs(s.result.cels) do
    if c.layer == layer and c.frame == frame then return s.blobs[c.blob + 1] end
  end
end

local function rgbaCanvas(w, h, px)
  local cells = {}
  for i = 1, w * h do cells[i] = "\0\0\0\0" end
  for _, p in ipairs(px) do cells[p[2] * w + p[1] + 1] = string.char(table.unpack(p[3])) end
  return table.concat(cells)
end

local RED, BLUE = { 255, 0, 0, 255 }, { 0, 0, 255, 255 }

local function failsWith(fn, pattern)
  local passed, problem = pcall(fn)
  check(not passed, "expected an error matching " .. pattern)
  check(tostring(problem):find(pattern, 1, true), "error was: " .. tostring(problem))
end

local cases = {}
local function case(name, fn) cases[#cases + 1] = { name = name, fn = fn } end

case("new rgb sprite snapshot has the documented shape", function()
  local r = call("new_sprite", { width = 4, height = 3, colorMode = "rgb" })
  check(r.sprite == true and r.width == 4 and r.height == 3 and type(r.spriteId) == "number", "new_sprite result")
  local s = snap(r.spriteId)
  check(s.result.sprite.id == r.spriteId and s.result.sprite.colorMode == "rgb", "sprite info")
  check(s.result.sprite.path == nil and s.result.selection == nil, "absent optionals are omitted")
  same(s.result.layers, { { path = "Layer 1", visible = true, opacity = 255, blend = "normal", group = false } }, "layers")
  same(s.result.frames, { { duration = 100 } }, "frames")
  for i, c in ipairs(s.result.cels) do check(#s.blobs[c.blob + 1] == 4 * 3 * 4, "cel " .. i .. " is full-canvas rgba") end
end)

case("commit writes pixels as one trimmed cel", function()
  local id = call("new_sprite", { width = 4, height = 3 }).spriteId
  local base = celBytes(snap(id), "Layer 1", 0)
  local next = rgbaCanvas(4, 3, { { 1, 1, RED }, { 2, 2, BLUE } })
  local r = call("commit", {
    sprite = id, label = "dots", ops = {},
    writes = { { layer = "Layer 1", frame = 0, base = base and 0 or nil, next = base and 1 or 0 } },
  }, base and { base, next } or { next })
  same(r, { applied = true, label = "dots", cels = 1 }, "reply")
  check(celBytes(snap(id), "Layer 1", 0) == next, "snapshot returns the written canvas")
  local b = app.activeSprite.layers[1]:cel(1).bounds
  check(b.x == 1 and b.y == 1 and b.width == 2 and b.height == 2, "cel trimmed to content")
end)

case("commit is one undo step and redo restores it", function()
  local id = call("new_sprite", { width = 3, height = 3 }).spriteId
  local before = snap(id)
  local px = rgbaCanvas(3, 3, { { 0, 0, RED } })
  local r = call("commit", {
    sprite = id, label = "many",
    ops = {
      { op = "layer.add", path = "Top" },
      { op = "layer.set", path = "Layer 1", opacity = 128, visible = false },
      { op = "frames.set", count = 2, durations = { 80, 120 } },
      { op = "tag.set", name = "walk", from = 0, to = 1, direction = "pingpong" },
    },
    writes = { { layer = "Top", frame = 0, next = 0 }, { layer = "Top", frame = 1, next = 0 } },
  }, { px })
  check(r.applied, "applied")
  local after = snap(id)
  same(after.result.frames, { { duration = 80 }, { duration = 120 } }, "durations")
  same(after.result.tags, { { name = "walk", from = 0, to = 1, direction = "pingpong" } }, "tags")
  check(celBytes(after, "Top", 1) == px, "second frame written")
  same(call("history", { action = "undo", steps = 1 }), { done = "undo", steps = 1 }, "history reply")
  same(snap(id), before, "one undo restores everything")
  call("history", { action = "redo", steps = 1 })
  same(snap(id), after, "redo restores the commit")
end)

case("canvas.resize moves art by the offset in one undo step and trims what leaves the canvas", function()
  local id = call("new_sprite", { width = 4, height = 3 }).spriteId
  call("commit", {
    sprite = id, label = "dots", ops = {}, writes = { { layer = "Layer 1", frame = 0, next = 0 } },
  }, { rgbaCanvas(4, 3, { { 0, 0, RED }, { 3, 2, BLUE } }) })
  local before = snap(id)
  local moved = rgbaCanvas(6, 5, { { 2, 1, RED }, { 5, 3, BLUE } })
  local next = rgbaCanvas(6, 5, { { 0, 0, BLUE }, { 2, 1, RED }, { 5, 3, BLUE } })
  local r = call("commit", {
    sprite = id, label = "grow", ops = { { op = "canvas.resize", width = 6, height = 5, x = 2, y = 1 } },
    writes = { { layer = "Layer 1", frame = 0, base = 0, next = 1 } },
  }, { moved, next })
  check(r.applied, "applied: CAS compares against the moved canvas")
  local after = snap(id)
  check(after.result.sprite.width == 6 and after.result.sprite.height == 5, "canvas is 6x5")
  check(celBytes(after, "Layer 1", 0) == next, "art moved by (2, 1) plus the new pixel")
  call("history", { action = "undo", steps = 1 })
  same(snap(id), before, "one undo restores size and art")
  call("commit", {
    sprite = id, label = "shrink then grow", writes = {},
    ops = { { op = "canvas.resize", width = 2, height = 2, x = 0, y = 0 }, { op = "canvas.resize", width = 4, height = 3, x = 0, y = 0 } },
  })
  check(celBytes(snap(id), "Layer 1", 0) == rgbaCanvas(4, 3, { { 0, 0, RED } }), "pixels cut by the shrink stay gone")
end)

case("CAS conflict changes nothing and returns the current bytes", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  local base = celBytes(snap(id), "Layer 1", 0)
  local artist = rgbaCanvas(2, 2, { { 1, 1, BLUE } })
  call("commit", { sprite = id, label = "artist", ops = {}, writes = { { layer = "Layer 1", frame = 0, base = base and 0 or nil, next = base and 1 or 0 } } },
    base and { base, artist } or { artist })
  local before = snap(id)
  local px = rgbaCanvas(2, 2, { { 0, 0, RED } })
  local r = call("commit", { sprite = id, label = "b", ops = {}, writes = { { layer = "Layer 1", frame = 0, base = 0, next = 1 } } }, { artist, px })
  check(r.applied, "setup commit")
  call("history", { action = "undo", steps = 1 })
  same(snap(id), before, "setup undo")
  local stale = rgbaCanvas(2, 2, {})
  local blobs
  r, blobs = call("commit", {
    sprite = id, label = "c",
    ops = { { op = "layer.add", path = "New" } },
    writes = {
      { layer = "Layer 1", frame = 0, base = 0, next = 1 },
      { layer = "New", frame = 0, base = 0, next = 1 },
    },
  }, { stale, px })
  same(r, { applied = false, reason = "conflict", conflicts = { { write = 0, blob = 0 } } }, "reply")
  check(#blobs == 1 and blobs[1] == artist, "reply carries the current bytes")
  same(snap(id), before, "sprite unchanged")
  call("history", { action = "redo", steps = 1 })
  check(celBytes(snap(id), "Layer 1", 0) == px, "redo stack survives a rejected commit")
end)

case("conflict on a missing cel omits the blob index", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  call("commit", { sprite = id, label = "add", ops = { { op = "layer.add", path = "Empty" } }, writes = {} })
  local r, blobs = call("commit", {
    sprite = id, label = "x", ops = {}, writes = { { layer = "Empty", frame = 0, base = 0, next = 0 } },
  }, { rgbaCanvas(2, 2, { { 1, 1, RED } }) })
  same(r, { applied = false, reason = "conflict", conflicts = { { write = 0 } } }, "reply")
  check(#blobs == 0, "no blobs")
end)

case("structure error changes nothing", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  local before = snap(id)
  local r = call("commit", {
    sprite = id, label = "bad",
    ops = { { op = "layer.add", path = "X" }, { op = "layer.set", path = "Missing", visible = false } },
    writes = {},
  })
  check(r.applied == false and r.reason == "structure" and r.message:find("Missing", 1, true), "structure reply")
  same(snap(id), before, "unchanged after bad op")
  r = call("commit", { sprite = id, label = "bad", ops = {}, writes = { { layer = "Layer 1", frame = 5, next = 0 } } },
    { rgbaCanvas(2, 2, {}) })
  check(r.reason == "structure" and r.message:find("frame 5", 1, true), "missing frame")
  r = call("commit", { sprite = id, label = "bad", ops = { { op = "layer.spin" } }, writes = {} })
  check(r.reason == "structure", "unknown op")
  same(snap(id), before, "unchanged after all")
end)

case("an error mid-commit rolls back the applied ops", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  local before = snap(id)
  failsWith(function()
    call("commit", {
      sprite = id, label = "short", ops = { { op = "layer.add", path = "Y" }, { op = "frames.set", count = 3, durations = { 1, 2, 3 } } },
      writes = { { layer = "Y", frame = 0, next = 0 } },
    }, { "abc" })
  end, "Blob 0 has 3 bytes")
  same(snap(id), before, "rolled back")
end)

case("layer ops handle groups, below, rename and remove", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  local sprite = app.activeSprite
  local g = sprite:newGroup()
  g.name = "G"
  local r = call("commit", {
    sprite = id, label = "layers",
    ops = {
      { op = "layer.add", path = "G/child" },
      { op = "layer.add", path = "Under", below = "Layer 1" },
      { op = "layer.set", path = "G", rename = "H" },
      { op = "palette.append", colors = { "#11223344", "#556677" } },
    },
    writes = { { layer = "H/child", frame = 0, next = 0 } },
  }, { rgbaCanvas(2, 2, { { 0, 0, BLUE } }) })
  check(r.applied, "applied: " .. tostring(r.message))
  local s = snap(id)
  local paths = {}
  for i, l in ipairs(s.result.layers) do paths[i] = l.path end
  same(paths, { "Under", "Layer 1", "H/child", "H" }, "layer order")
  check(s.result.layers[4].group == true, "group flag")
  local pal = s.result.palette
  check(pal[#pal - 1] == "#11223344" and pal[#pal] == "#556677ff", "palette appended")
  r = call("commit", { sprite = id, label = "rm", ops = { { op = "layer.remove", path = "H" } }, writes = {} })
  check(r.applied, "remove applied")
  paths = {}
  for i, l in ipairs(snap(id).result.layers) do paths[i] = l.path end
  same(paths, { "Under", "Layer 1" }, "group and child removed")
  r = call("commit", { sprite = id, label = "dup", ops = { { op = "layer.add", path = "Under" } }, writes = {} })
  check(r.reason == "structure", "duplicate layer")
end)

case("indexed sprite round-trips index bytes", function()
  local id = call("new_sprite", { width = 3, height = 2, colorMode = "indexed" }).spriteId
  local s = snap(id)
  check(s.result.sprite.colorMode == "indexed" and s.result.sprite.transparentIndex == 0, "mode and transparent index")
  check(#s.result.palette > 3 and s.result.palette[1]:match("^#%x+$"), "palette as #rrggbbaa")
  local bytes = string.char(0, 2, 3, 0, 3, 0)
  local r = call("commit", {
    sprite = id, label = "idx", ops = {},
    writes = { { layer = "Layer 1", frame = 0, base = celBytes(s, "Layer 1", 0) and 0 or nil, next = 1 } },
  }, { string.rep("\0", 6), bytes })
  check(r.applied, "applied")
  check(celBytes(snap(id), "Layer 1", 0) == bytes, "indexed bytes back")
end)

case("gray sprite round-trips value and alpha bytes", function()
  local id = call("new_sprite", { width = 2, height = 2, colorMode = "gray" }).spriteId
  local s = snap(id)
  check(s.result.sprite.colorMode == "gray", "mode")
  local bytes = string.char(200, 255, 0, 0, 0, 0, 90, 128)
  local r = call("commit", {
    sprite = id, label = "gray", ops = {},
    writes = { { layer = "Layer 1", frame = 0, base = celBytes(s, "Layer 1", 0) and 0 or nil, next = 1 } },
  }, { string.rep("\0", 8), bytes })
  check(r.applied, "applied")
  check(celBytes(snap(id), "Layer 1", 0) == bytes, "gray bytes back")
end)

case("sprites lists stable ids and select activates by id or name", function()
  local a = call("new_sprite", { width = 5, height = 5 }).spriteId
  local b = call("new_sprite", { width = 6, height = 6 }).spriteId
  check(a ~= b, "distinct ids")
  local r = call("sprites", {})
  check(r.active == b, "newest is active")
  local seen = {}
  for _, s in ipairs(r.sprites) do seen[s.id] = s end
  check(seen[a].width == 5 and seen[a].active == false and seen[b].active == true and seen[a].frames == 1, "entries")
  r = call("sprites", { select = a })
  check(r.active == a and app.activeSprite.width == 5, "select by id")
  check(call("sprites", {}).active == a, "ids stable across calls")
  failsWith(function() call("sprites", { select = 999 }) end, "No open sprite '999'")
end)

case("save, open and their errors", function()
  local id = call("new_sprite", { width = 2, height = 2 }).spriteId
  failsWith(function() call("save", {}) end, "never been saved")
  local path = app.fs.joinPath(dir, "saved.aseprite")
  call("commit", { sprite = id, label = "px", ops = {}, writes = { { layer = "Layer 1", frame = 0, next = 0 } } },
    { rgbaCanvas(2, 2, { { 1, 0, RED } }) })
  same(call("save", { path = path }), { saved = path, copy = false }, "save reply")
  check(app.fs.isFile(path), "file written")
  same(call("save", {}), { saved = path, copy = false }, "save to its own file")
  local saved = snap(id)
  app.activeSprite:close()
  failsWith(function() call("open", { path = path .. ".missing" }) end, "File not found: " .. path .. ".missing")
  local r = call("open", { path = path })
  check(r.spriteId ~= id and r.width == 2, "open reply")
  local reopened = snap(r.spriteId)
  check(reopened.result.sprite.path == path, "path reported")
  check(celBytes(reopened, "Layer 1", 0) == celBytes(saved, "Layer 1", 0), "pixels survive the file")
end)

case("backup copies a sprite that is not active without touching it", function()
  local a = call("new_sprite", { width = 2, height = 2 }).spriteId
  local own = app.fs.joinPath(dir, "own.aseprite")
  call("save", { path = own })
  call("commit", { sprite = a, label = "dirty", ops = {}, writes = { { layer = "Layer 1", frame = 0, next = 0 } } },
    { rgbaCanvas(2, 2, { { 0, 1, RED } }) })
  local spriteA = app.activeSprite
  check(spriteA.isModified, "a is dirty")
  local b = call("new_sprite", { width = 3, height = 3 }).spriteId
  local target = app.fs.joinPath(dir, "backup.aseprite")
  same(call("backup", { sprite = a, path = target }), { saved = target, copy = true }, "backup reply")
  check(app.fs.isFile(target), "copy written")
  check(spriteA.filename == own and spriteA.isModified, "file name and dirty state kept")
  check(call("sprites", {}).active == b, "active sprite unchanged")
  failsWith(function() call("backup", { sprite = 4242, path = target }) end, "No open sprite '4242'")
end)

case("plugin init adds File > Aseprite MCP... and waits for a token", function()
  local command
  local fake = {
    path = ext, preferences = {},
    newCommand = function(_, def) command = def end,
  }
  init(fake)
  check(command and command.title == "Aseprite MCP..." and command.group == "file_scripts", "menu command")
  check(fake.preferences.token == nil, "no token, no connection")
  exit(fake)
end)

case("unknown command is an error", function()
  failsWith(function() call("nope", {}) end, "Unknown command 'nope'")
end)

case("binary frame decodes what Node encoded", function()
  local f = assert(io.open(app.fs.joinPath(dir, "node-frame.bin"), "rb"))
  local data = f:read("a")
  f:close()
  local msg, blobs = wire.decodeFrame(data)
  same(msg, { id = 7, cmd = "x", args = { text = "é \"q\"\n", n = -2.5, list = { 1, true } } }, "msg")
  same(blobs, { "\1\2\3", "" }, "blobs")
end)

local results = {}
for _, c in ipairs(cases) do
  local ok, err = pcall(c.fn)
  results[#results + 1] = { name = c.name, ok = ok, error = ok and "" or tostring(err) }
end

local frame = wire.encodeFrame({ id = 9, ok = true, result = { text = "ü\t", nested = { a = { 1, 2 } } } }, { "\0\255", "xyz" })
local f = assert(io.open(app.fs.joinPath(dir, "lua-frame.bin"), "wb"))
f:write(frame)
f:close()

local out = assert(io.open(app.params.out, "w"))
out:write(wire.encode({
  cases = results,
  sha = {
    empty = sha256.hex(""),
    abc = sha256.hex("abc"),
    long = sha256.hex(string.rep("a", 1000)),
  },
  hmac = sha256.hmacHex("token-1234567890abcd", "client|a|b"),
  hmacLongKey = sha256.hmacHex(string.rep("k", 100), "server|b|a"),
}))
out:close()
