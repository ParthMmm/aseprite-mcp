-- The commands the daemon sends. Pixels cross only as Image.bytes strings: full-canvas, in the sprite's mode.

local M = { VERSION = "0.2.0" }

local STRUCTURE = "\0structure:"

local function structure(msg)
  error(STRUCTURE .. msg, 0)
end

local function fail(msg)
  error(msg, 0)
end

-- Sprite userdata wrappers are fresh on every access, so a weak table keyed by sprite never hits;
-- ids live in a list matched with the Sprite __eq metamethod instead.
local registry = {}
local nextId = 1

local function sameSprite(a, b)
  local ok, same = pcall(function() return a == b end)
  return ok and same
end

local function spriteId(sprite)
  for _, entry in ipairs(registry) do
    if sameSprite(entry.sprite, sprite) then return entry.id end
  end
  local id = nextId
  nextId = nextId + 1
  registry[#registry + 1] = { sprite = sprite, id = id }
  return id
end

local function openSprites()
  local live = {}
  for _, s in ipairs(app.sprites) do
    live[#live + 1] = { sprite = s, id = spriteId(s) }
  end
  registry = live
  return live
end

local function nameOf(sprite)
  return app.fs.fileName(sprite.filename)
end

local function resolve(ref)
  if ref == nil then
    return app.activeSprite or fail("No active sprite.")
  end
  for _, entry in ipairs(openSprites()) do
    if entry.id == ref or nameOf(entry.sprite) == ref then return entry.sprite end
  end
  fail("No open sprite '" .. tostring(ref) .. "'.")
end

local MODE_NAMES = {
  [ColorMode.RGB] = "rgb",
  [ColorMode.INDEXED] = "indexed",
  [ColorMode.GRAY] = "gray",
}
local MODES = { rgb = ColorMode.RGB, indexed = ColorMode.INDEXED, gray = ColorMode.GRAY }
local BYTES_PER_PIXEL = { rgb = 4, gray = 2, indexed = 1 }

local BLEND_NAMES = {}
for _, k in ipairs({
  "NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT",
  "SOFT_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY", "ADDITION", "SUBTRACT",
  "DIVIDE",
}) do
  BLEND_NAMES[BlendMode[k]] = k:lower()
end

local DIRECTIONS = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG }
local DIRECTION_NAMES = {
  [AniDir.FORWARD] = "forward",
  [AniDir.REVERSE] = "reverse",
  [AniDir.PING_PONG] = "pingpong",
  [AniDir.PING_PONG_REVERSE] = "pingpong",
}

local function modeOf(sprite)
  return MODE_NAMES[sprite.colorMode] or fail("Unsupported colour mode in '" .. nameOf(sprite) .. "'.")
end

local function blankBytes(sprite)
  local fill = sprite.colorMode == ColorMode.INDEXED and string.char(sprite.transparentColor) or "\0"
  return string.rep(fill, sprite.width * sprite.height * BYTES_PER_PIXEL[modeOf(sprite)])
end

local function canvasBytes(sprite, cel)
  if not cel then return nil end
  local canvas = Image(sprite.spec)
  canvas.bytes = blankBytes(sprite)
  canvas:drawImage(cel.image, cel.position, 255, BlendMode.SRC)
  return canvas.bytes
end

-- Bottom to top; a group follows its children, as in Aseprite's own flattened order.
local function layerList(sprite)
  local out = {}
  local function walk(layers, prefix)
    for _, layer in ipairs(layers) do
      local path = prefix .. layer.name
      if layer.isGroup then walk(layer.layers, path .. "/") end
      out[#out + 1] = { layer = layer, path = path }
    end
  end
  walk(sprite.layers, "")
  return out
end

local function findLayer(sprite, path)
  for _, entry in ipairs(layerList(sprite)) do
    if entry.path == path then return entry.layer end
  end
end

local function needLayer(sprite, path)
  return findLayer(sprite, path) or structure("layer '" .. tostring(path) .. "' does not exist")
end

local function hexColor(c)
  return string.format("#%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
end

local function parseColor(hex)
  local h = tostring(hex):gsub("^#", "")
  if #h == 6 then h = h .. "ff" end
  if not h:match("^%x%x%x%x%x%x%x%x$") then structure("bad colour '" .. tostring(hex) .. "'") end
  local r, g, b, a = tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16), tonumber(h:sub(7, 8), 16)
  return Color { r = r, g = g, b = b, a = a }
end

local function spriteInfo(sprite)
  return { spriteId = spriteId(sprite), name = nameOf(sprite), width = sprite.width, height = sprite.height }
end

local handlers = {}

function handlers.new_sprite(args)
  local mode = MODES[args.colorMode or "rgb"] or fail("Unknown colour mode '" .. tostring(args.colorMode) .. "'.")
  local sprite = Sprite(args.width, args.height, mode)
  app.activeSprite = sprite
  local info = spriteInfo(sprite)
  info.sprite = true
  return info
end

function handlers.open(args)
  local path = args.path
  if type(path) ~= "string" or not app.fs.isFile(path) then fail("File not found: " .. tostring(path)) end
  local sprite = app.open(path) or fail("Aseprite could not open " .. path)
  app.activeSprite = sprite
  return spriteInfo(sprite)
end

function handlers.save(args)
  local sprite = resolve(nil)
  local path = args.path
  if path == nil then
    if not app.fs.isFile(sprite.filename) then fail("The sprite has never been saved; pass a path.") end
    path = sprite.filename
  end
  sprite:saveAs(path)
  return { saved = path, copy = false }
end

-- Copies the sprite to `path` without activating it or touching its file name or dirty state.
function handlers.backup(args)
  if args.sprite == nil then fail("backup needs a sprite id.") end
  local sprite = resolve(args.sprite)
  local active = app.activeSprite
  sprite:saveCopyAs(args.path)
  -- saveCopyAs switches the active sprite to the one it saves.
  if active then app.activeSprite = active end
  return { saved = args.path, copy = true }
end

function handlers.sprites(args)
  if args.select ~= nil then app.activeSprite = resolve(args.select) end
  local active = app.activeSprite
  local result = { sprites = {} }
  for _, entry in ipairs(openSprites()) do
    local s = entry.sprite
    local isActive = active ~= nil and sameSprite(s, active)
    if isActive then result.active = entry.id end
    result.sprites[#result.sprites + 1] = {
      id = entry.id, name = nameOf(s), width = s.width, height = s.height, frames = #s.frames, active = isActive,
    }
  end
  return result
end

function handlers.history(args)
  local action = args.action
  local step = (action == "undo" and app.undo) or (action == "redo" and app.redo)
    or fail("history action must be 'undo' or 'redo'.")
  resolve(nil)
  local steps = args.steps or 1
  for _ = 1, steps do step() end
  return { done = action, steps = steps }
end

function handlers.snapshot(args)
  local sprite = resolve(args.sprite)
  local info = {
    id = spriteId(sprite), name = nameOf(sprite), width = sprite.width, height = sprite.height,
    colorMode = modeOf(sprite), transparentIndex = sprite.transparentColor,
  }
  if app.fs.isFile(sprite.filename) then info.path = sprite.filename end

  local palette = {}
  local source = sprite.palettes[1]
  for i = 0, #source - 1 do palette[#palette + 1] = hexColor(source:getColor(i)) end

  local layers, cels, blobs = {}, {}, {}
  for _, entry in ipairs(layerList(sprite)) do
    local layer = entry.layer
    layers[#layers + 1] = {
      path = entry.path, visible = layer.isVisible, opacity = layer.opacity or 255,
      blend = BLEND_NAMES[layer.blendMode] or "normal", group = layer.isGroup,
    }
    if layer.isImage and not layer.isTilemap then
      for f = 1, #sprite.frames do
        local bytes = canvasBytes(sprite, layer:cel(f))
        if bytes then
          blobs[#blobs + 1] = bytes
          cels[#cels + 1] = { layer = entry.path, frame = f - 1, blob = #blobs - 1 }
        end
      end
    end
  end

  local frames = {}
  for _, frame in ipairs(sprite.frames) do frames[#frames + 1] = { duration = math.floor(frame.duration * 1000 + 0.5) } end

  local tags = {}
  for _, tag in ipairs(sprite.tags) do
    tags[#tags + 1] = {
      name = tag.name, from = tag.fromFrame.frameNumber - 1, to = tag.toFrame.frameNumber - 1,
      direction = DIRECTION_NAMES[tag.aniDir] or "forward",
    }
  end

  local result = { sprite = info, palette = palette, layers = layers, frames = frames, tags = tags, cels = cels }
  if not sprite.selection.isEmpty then
    local b = sprite.selection.bounds
    result.selection = { b.x, b.y, b.width, b.height }
  end
  return result, blobs
end

local ops = {}

ops["layer.add"] = function(sprite, op)
  if findLayer(sprite, op.path) then structure("layer '" .. op.path .. "' already exists") end
  local parentPath, name = tostring(op.path):match("^(.*)/([^/]+)$")
  local parent
  if parentPath then
    parent = needLayer(sprite, parentPath)
    if not parent.isGroup then structure("layer '" .. parentPath .. "' is not a group") end
  end
  local below = op.below ~= nil and needLayer(sprite, op.below) or nil
  local layer = sprite:newLayer()
  layer.name = name or op.path
  if below then
    layer.parent = below.parent
    layer.stackIndex = below.stackIndex
  elseif parent then
    layer.parent = parent
  end
end

ops["layer.set"] = function(sprite, op)
  local layer = needLayer(sprite, op.path)
  if op.visible ~= nil then layer.isVisible = op.visible end
  if op.opacity ~= nil then layer.opacity = op.opacity end
  if op.rename ~= nil then layer.name = op.rename end
end

ops["layer.remove"] = function(sprite, op)
  sprite:deleteLayer(needLayer(sprite, op.path))
end

ops["frames.set"] = function(sprite, op)
  local count = op.count
  if math.type(count) == nil or count < 1 or count ~= math.floor(count) then structure("frame count must be >= 1") end
  local durations = op.durations or {}
  if #durations ~= count then structure("frames.set needs one duration per frame") end
  while #sprite.frames < count do sprite:newEmptyFrame(#sprite.frames + 1) end
  while #sprite.frames > count do sprite:deleteFrame(#sprite.frames) end
  for i, ms in ipairs(durations) do sprite.frames[i].duration = ms / 1000 end
end

ops["tag.set"] = function(sprite, op)
  local n = #sprite.frames
  local from, to = op.from, op.to
  if type(from) ~= "number" or type(to) ~= "number" or from < 0 or to < from or to >= n then
    structure(string.format("tag '%s' frames %s..%s are outside 0..%d", tostring(op.name), tostring(from), tostring(to), n - 1))
  end
  local dir = DIRECTIONS[op.direction or "forward"] or structure("bad tag direction '" .. tostring(op.direction) .. "'")
  local tag
  for _, t in ipairs(sprite.tags) do
    if t.name == op.name then tag = t end
  end
  if tag then
    tag.fromFrame = sprite.frames[from + 1]
    tag.toFrame = sprite.frames[to + 1]
  else
    tag = sprite:newTag(from + 1, to + 1)
    tag.name = op.name
  end
  tag.aniDir = dir
end

ops["palette.append"] = function(sprite, op)
  local target = sprite.palettes[1]
  local colors = op.colors or {}
  local start = #target
  target:resize(start + #colors)
  for i, hex in ipairs(colors) do target:setColor(start + i - 1, parseColor(hex)) end
end

-- crop keeps pixels outside the new canvas, so cels are trimmed to it: the daemon's draft drops them.
ops["canvas.resize"] = function(sprite, op)
  for _, k in ipairs({ "width", "height", "x", "y" }) do
    if type(op[k]) ~= "number" then structure("canvas.resize needs a number " .. k) end
  end
  local w, h = math.floor(op.width), math.floor(op.height)
  if w < 1 or h < 1 then structure("canvas size must be at least 1x1") end
  sprite:crop(-math.floor(op.x), -math.floor(op.y), w, h)
  local cels = {}
  for _, cel in ipairs(sprite.cels) do
    if not cel.layer.isTilemap then cels[#cels + 1] = cel end
  end
  for _, cel in ipairs(cels) do
    local b = cel.bounds
    local keep = b:intersect(Rectangle(0, 0, w, h))
    if keep.isEmpty then
      sprite:deleteCel(cel)
    elseif keep.x ~= b.x or keep.y ~= b.y or keep.width ~= b.width or keep.height ~= b.height then
      local spec = cel.image.spec
      spec.width, spec.height = keep.width, keep.height
      local trimmed = Image(spec)
      trimmed:drawImage(cel.image, Point(b.x - keep.x, b.y - keep.y), 255, BlendMode.SRC)
      cel.image = trimmed
      cel.position = Point(keep.x, keep.y)
    end
  end
end

local function blobAt(blobs, index, size)
  if index == nil then return nil end
  local blob = blobs[index + 1] or fail("Blob " .. tostring(index) .. " is missing from the frame.")
  if #blob ~= size then fail(string.format("Blob %d has %d bytes; the canvas needs %d.", index, #blob, size)) end
  return blob
end

local function writeCel(sprite, layer, frame, bytes)
  local old = layer:cel(frame)
  if old then sprite:deleteCel(old) end
  if bytes == nil then return end
  local whole = Image(sprite.spec)
  whole.bytes = bytes
  local box = whole:shrinkBounds(sprite.colorMode == ColorMode.INDEXED and sprite.transparentColor or 0)
  if box.isEmpty then return end
  local spec = sprite.spec
  spec.width, spec.height = box.width, box.height
  local trimmed = Image(spec)
  trimmed:drawImage(whole, Point(-box.x, -box.y), 255, BlendMode.SRC)
  sprite:newCel(layer, frame, trimmed, Point(box.x, box.y))
end

function handlers.commit(args, blobs)
  local sprite = resolve(args.sprite)
  local writes = args.writes or {}
  local conflict

  local ok, err = pcall(app.transaction, "MCP: " .. tostring(args.label), function()
    for _, op in ipairs(args.ops or {}) do
      local apply = ops[op.op] or structure("unknown op '" .. tostring(op.op) .. "'")
      apply(sprite, op)
    end
    -- After the ops, so a canvas.resize sets the size the blobs must have.
    local blank = blankBytes(sprite)

    local targets = {}
    for i, w in ipairs(writes) do
      local layer = needLayer(sprite, w.layer)
      if not layer.isImage or layer.isTilemap then structure("layer '" .. w.layer .. "' cannot hold pixels") end
      if type(w.frame) ~= "number" or w.frame < 0 or w.frame >= #sprite.frames then
        structure("frame " .. tostring(w.frame) .. " does not exist")
      end
      targets[i] = { layer = layer, frame = w.frame + 1 }
    end

    local conflicts, current = {}, {}
    for i, w in ipairs(writes) do
      local t = targets[i]
      local now = canvasBytes(sprite, t.layer:cel(t.frame))
      local base = blobAt(blobs, w.base, #blank)
      if (now or blank) ~= (base or blank) then
        local c = { write = i - 1 }
        if now then
          current[#current + 1] = now
          c.blob = #current - 1
        end
        conflicts[#conflicts + 1] = c
      end
    end
    if #conflicts > 0 then
      conflict = { conflicts = conflicts, current = current }
      error("conflict", 0)
    end

    for i, w in ipairs(writes) do
      writeCel(sprite, targets[i].layer, targets[i].frame, blobAt(blobs, w.next, #blank))
    end
  end)

  if ok then return { applied = true, label = args.label, cels = #writes } end
  if conflict then return { applied = false, reason = "conflict", conflicts = conflict.conflicts }, conflict.current end
  if type(err) == "string" and err:sub(1, #STRUCTURE) == STRUCTURE then
    return { applied = false, reason = "structure", message = err:sub(#STRUCTURE + 1) }
  end
  error(err, 0)
end

--- Runs one command. Returns the result table and a list of reply blobs (byte strings).
function M.handle(cmd, args, blobs)
  local h = handlers[cmd]
  if not h then fail("Unknown command '" .. tostring(cmd) .. "'") end
  local result, out = h(args or {}, blobs or {})
  return result, out or {}
end

return M
