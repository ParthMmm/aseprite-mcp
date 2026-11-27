-- Draws the project icon and README banner: a brain-in-a-jar wizard clanker
-- casting spells at a row of space weirdos.
-- Run: aseprite -b --script scripts/art.lua
-- Writes .aseprite sources, scaled PNGs and animated GIFs to assets/.

local out = app.fs.joinPath(app.fs.currentPath, "assets")
app.fs.makeAllDirectories(out)

local N = 16 -- banner frames
local TAU = 2 * math.pi

-- Sweetie 16 palette.
local hex = {
  ["0"] = "1a1c2c", ["1"] = "5d275d", ["2"] = "b13e53", ["3"] = "ef7d57",
  ["4"] = "ffcd75", ["5"] = "a7f070", ["6"] = "38b764", ["7"] = "257179",
  ["8"] = "29366f", ["9"] = "3b5dc9", a = "41a6f6", b = "73eff7",
  c = "f4f4f4", d = "94b0c2", e = "566c86", f = "333c57",
}
local pal = {}
for k, h in pairs(hex) do
  pal[k] = app.pixelColor.rgba(
    tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16), 255)
end

-- Primitives -----------------------------------------------------------------

local function round(v) return math.floor(v + 0.5) end

-- A sine wave that loops cleanly when period divides N.
local function wave(t, period, amp, phase)
  return round(math.sin(t / period * TAU + (phase or 0)) * amp)
end

local function hash(a, b)
  local h = (a * 374761393 + b * 668265263) % 2147483647
  h = (h ~ (h >> 13)) * 1274126177 % 2147483647
  return h
end

local function px(img, x, y, k)
  if x >= 0 and y >= 0 and x < img.width and y < img.height then
    img:drawPixel(x, y, pal[k])
  end
end

local function rect(img, x0, y0, x1, y1, k)
  for y = y0, y1 do
    for x = x0, x1 do px(img, x, y, k) end
  end
end

-- Rect with its corners cut by c pixels.
local function rrect(img, x0, y0, x1, y1, k, c)
  c = c or 1
  for y = y0, y1 do
    for x = x0, x1 do
      local dx = math.min(x - x0, x1 - x)
      local dy = math.min(y - y0, y1 - y)
      if dx + dy >= c then px(img, x, y, k) end
    end
  end
end

local function ellipse(img, cx, cy, rx, ry, k, half)
  for y = math.floor(cy - ry), math.ceil(cy + ry) do
    for x = math.floor(cx - rx), math.ceil(cx + rx) do
      local nx, ny = (x - cx) / rx, (y - cy) / ry
      local inside = nx * nx + ny * ny <= 1.05
      if half == "top" and y > cy then inside = false end
      if half == "bottom" and y <= cy then inside = false end
      if inside then px(img, x, y, k) end
    end
  end
end

local function disc(img, cx, cy, r, k) ellipse(img, cx, cy, r, r, k) end

-- Outlined disc: dark rim, then fill.
local function ball(img, cx, cy, r, k)
  disc(img, cx, cy, r + 1, "0")
  disc(img, cx, cy, r, k)
end

-- Stamp a grid of palette keys; "." is transparent.
local function stamp(img, x0, y0, rows)
  for y, row in ipairs(rows) do
    for x = 1, #row do
      local k = row:sub(x, x)
      if k ~= "." then px(img, x0 + x - 1, y0 + y - 1, k) end
    end
  end
end

-- Type -------------------------------------------------------------------------

local font = {
  A = { ".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#" },
  C = { ".####", "#....", "#....", "#....", "#....", "#....", ".####" },
  E = { "#####", "#....", "#....", "####.", "#....", "#....", "#####" },
  I = { "#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####" },
  M = { "#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#" },
  P = { "####.", "#...#", "#...#", "####.", "#....", "#....", "#...." },
  R = { "####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#" },
  S = { ".####", "#....", "#....", ".###.", "....#", "....#", "####." },
  T = { "#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.." },
}

-- One glyph at 2x, with a vertical color ramp per glyph row.
local function glyph2x(img, x, y, ch, ramp, shadow)
  local g = font[ch]
  if not g then return end
  for pass = 1, 2 do
    for gy, row in ipairs(g) do
      for gx = 1, 5 do
        if row:sub(gx, gx) == "#" then
          local X, Y = x + (gx - 1) * 2, y + (gy - 1) * 2
          if pass == 1 then
            rect(img, X + 1, Y + 1, X + 2, Y + 2, shadow)
            rect(img, X + 2, Y + 2, X + 2, Y + 2, "0")
          else
            local k = ramp[math.min(#ramp, math.ceil(gy * #ramp / 7))]
            rect(img, X, Y, X + 1, Y + 1, k)
          end
        end
      end
    end
  end
end

local runes = {
  { "#.#", "###", ".#.", ".#.", "#.#" },
  { "###", "#.#", "#..", "#.#", "###" },
  { ".#.", "#.#", ".#.", "###", ".#." },
  { "#..", "##.", "#.#", "##.", "#.." },
  { "###", ".#.", "#.#", ".#.", "###" },
  { "#.#", ".#.", "###", ".#.", "#.#" },
  { "##.", "..#", ".#.", "#..", ".##" },
  { ".##", "#..", "###", "..#", "##." },
}

local function rune(img, x, y, i, k)
  for gy, row in ipairs(runes[i]) do
    for gx = 1, 3 do
      if row:sub(gx, gx) == "#" then px(img, x + gx - 1, y + gy - 1, k) end
    end
  end
end

-- Backdrop ---------------------------------------------------------------------

local bayer = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 }

-- Dithered nebula. clouds: { cx, cy, radius, inner key, outer key }.
local function nebula(img, clouds)
  rect(img, 0, 0, img.width - 1, img.height - 1, "f")
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local th = (bayer[(y % 4) * 4 + (x % 4) + 1] + 0.5) / 16
      for _, c in ipairs(clouds) do
        local d = math.sqrt((x - c[1]) ^ 2 + ((y - c[2]) * 1.6) ^ 2) / c[3]
        local v = 1 - d
        if v > 0.5 + th * 0.25 then px(img, x, y, c[4])
        elseif v > 0.05 + th * 0.25 then px(img, x, y, c[5]) end
      end
    end
  end
end

local function stars(img, count, t, seed)
  for i = 1, count do
    local x = hash(i, seed) % img.width
    local y = hash(seed, i * 7) % img.height
    local phase = (i * 5 + t) % 12
    if phase == 0 then
      px(img, x, y, "c")
      px(img, x - 1, y, "d"); px(img, x + 1, y, "d"); px(img, x, y - 1, "d"); px(img, x, y + 1, "d")
    elseif phase < 3 then
      px(img, x, y, "c")
    else
      px(img, x, y, (i % 3 == 0) and "d" or "e")
    end
  end
end

-- The wizard clanker ---------------------------------------------------------------
-- 32 wide. Hat at the top, brain jar at y 12..26, collar, cable beard, then
-- (unless headOnly) a boiler body on rocket jets with a pencil wand.

local function wizard(img, ox, oy, t, headOnly)
  local function r(x0, y0, x1, y1, k) rect(img, ox + x0, oy + y0, ox + x1, oy + y1, k) end
  local function p(x, y, k) px(img, ox + x, oy + y, k) end

  -- Body first so the beard hangs over it.
  if not headOnly then
    -- Rocket jets.
    for i, nx in ipairs({ 9, 18 }) do
      r(nx, 43, nx + 4, 46, "0"); r(nx + 1, 43, nx + 3, 45, "e"); p(nx + 1, 43, "d")
      local len = 4 + (t + i * 2) % 4
      for j = 0, len do
        local k = j < 1 and "c" or j < 3 and "4" or j < 5 and "3" or "2"
        local half = j < len - 1 and 1 or 0
        rect(img, ox + nx + 2 - half, oy + 47 + j, ox + nx + 2 + half, oy + 47 + j, k)
      end
      -- Sparks shed by the jets.
      local s = (t * 3 + i * 5) % 8
      p(nx + 2 + ((s % 2 == 0) and -2 or 2), 49 + s, (s < 4) and "4" or "3")
    end

    -- Torso.
    rrect(img, ox + 7, oy + 28, ox + 24, oy + 44, "0", 2)
    rrect(img, ox + 8, oy + 29, ox + 23, oy + 43, "e", 2)
    r(8, 30, 8, 41, "d")
    r(23, 30, 23, 41, "f")
    -- Pulsing core.
    ball(img, ox + 15.5, oy + 39, 2, (t % 4 < 2) and "b" or "a")
    p(15, 38, "c")

    -- Left arm, a claw.
    r(3, 31, 7, 38, "0"); r(4, 32, 6, 37, "e"); p(4, 32, "d")
    r(2, 38, 3, 40, "0"); r(7, 38, 8, 40, "0")

    -- Right arm raised, holding the pencil wand.
    r(24, 30, 28, 34, "0"); r(25, 31, 27, 33, "e")
    for pass = 1, 2 do
      for i = 0, 9 do
        local x, y = ox + 28 + i, oy + 31 - i
        if pass == 1 then
          rect(img, x - 1, y - 1, x + 2, y + 1, "0")
        elseif i < 8 then
          px(img, x, y, "4"); px(img, x + 1, y, "3")
        else
          px(img, x, y, "c"); px(img, x + 1, y, "d")
        end
      end
    end
    r(26, 29, 29, 32, "0"); r(27, 30, 28, 31, "d")

    -- Star on the wand tip.
    local sx, sy = ox + 39, oy + 20
    if t % 4 < 2 then
      rect(img, sx - 3, sy, sx + 3, sy, "4"); rect(img, sx, sy - 3, sx, sy + 3, "4")
      rect(img, sx - 1, sy - 1, sx + 1, sy + 1, "4"); px(img, sx, sy, "c")
    else
      px(img, sx, sy, "c")
      for d = 1, 2 do
        px(img, sx - d, sy - d, "4"); px(img, sx + d, sy - d, "4")
        px(img, sx - d, sy + d, "4"); px(img, sx + d, sy + d, "4")
      end
    end
  end

  -- Collar.
  r(4, 26, 27, 28, "0")
  r(5, 27, 26, 27, "e")
  for x = 6, 25, 4 do p(x, 27, "c") end

  -- Cable beard with plugs.
  local cables = { "2", "4", "6", "a", "3", "5" }
  for i, k in ipairs(cables) do
    local bx = 8 + (i - 1) * 3
    local len = headOnly and 6 or (3 + (i * 3) % 3)
    local lastx
    for j = 0, len do
      local x = bx + round(math.sin(j * 0.7 + t / 8 * TAU + i) * 1.2)
      p(x - 1, 29 + j, "0"); p(x + 1, 29 + j, "0")
      p(x, 29 + j, k)
      lastx = x
    end
    if not headOnly then p(lastx, 30 + len, "0") end
  end

  -- Brain jar.
  rrect(img, ox + 5, oy + 11, ox + 26, oy + 26, "0", 3)
  rrect(img, ox + 6, oy + 12, ox + 25, oy + 25, "7", 3)
  local function inJar(x, y)
    local dx = math.min(x - 6, 25 - x)
    local dy = math.min(y - 12, 25 - y)
    return x >= 6 and x <= 25 and y >= 12 and y <= 25 and dx + dy >= 3
  end
  -- Green goo with a wobbling surface.
  for x = 6, 25 do
    local surf = 17 + round(math.sin(x * 0.7 + t / 8 * TAU) * 0.8)
    for y = surf, 25 do
      if inJar(x, y) then p(x, y, y == surf and "5" or "6") end
    end
  end
  -- The brain floats.
  local bb = wave(t, 8, 1)
  local bcx, bcy = ox + 15.5, oy + 18 + bb
  ellipse(img, bcx, bcy, 7.5, 5.5, "0")
  ellipse(img, bcx, bcy, 6.5, 4.5, "3")
  for y = -4, 4 do
    for x = -6, 7 do
      local X, Y = math.floor(bcx) + x, math.floor(bcy) + y
      local nx, ny = (X - bcx) / 6.5, (Y - bcy) / 4.5
      if nx * nx + ny * ny <= 1 and (x * 2 + y * 3 + (x * y) % 3) % 5 == 0 then
        px(img, X, Y, "2")
      end
    end
  end
  px(img, math.floor(bcx) - 4, math.floor(bcy) - 3, "4")
  px(img, math.floor(bcx) - 3, math.floor(bcy) - 3, "4")
  -- Brain stem.
  for y = math.floor(bcy) + 5, oy + 25 do px(img, ox + 15, y, "2"); px(img, ox + 16, y, "1") end
  -- One big eye on the brain.
  local ex, ey = ox + 14, oy + 17 + bb
  rect(img, ex - 1, ey - 1, ex + 4, ey + 3, "0")
  if t == 10 or t == 11 then
    rect(img, ex, ey + 1, ex + 3, ey + 1, "3")
    rect(img, ex, ey + 2, ex + 3, ey + 2, "0")
  else
    rect(img, ex, ey, ex + 3, ey + 2, "c")
    local look = { 0, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0 }
    local lx = look[t % 16 + 1]
    rect(img, ex + lx, ey + 1, ex + lx + 1, ey + 2, "0")
    px(img, ex + lx, ey + 1, "9")
  end
  -- Bubbles.
  for k = 0, 2 do
    local age = (t + k * 5) % 8
    local x = ({ 8, 22, 11 })[k + 1]
    local y = 25 - age
    if y >= 18 and inJar(x, y) then p(x, y, "b") end
  end
  -- Glass glints.
  r(7, 14, 7, 17, "c"); r(7, 18, 7, 20, "d"); p(8, 13, "c"); p(24, 22, "d")

  -- Floating wizard hat.
  local hy = oy + wave(t, 16, 1, 1)
  local function hp(x, y, k) px(img, ox + x, hy + y, k) end
  local function center(row) return 16 + round(((9 - row) ^ 2) * 0.07) end
  for pass = 1, 2 do
    for row = 0, 9 do
      local w = round(row * 0.85)
      local cx = center(row)
      if pass == 1 then
        rect(img, ox + cx - w - 1, hy + row - 1, ox + cx + w + 1, hy + row, "0")
      else
        rect(img, ox + cx - w, hy + row, ox + cx + w, hy + row, "9")
        hp(cx - w, row, "a")
        hp(cx + w, row, "8")
      end
    end
  end
  -- Band and stars.
  for x = center(8) - 7, center(8) + 7 do hp(x, 8, "4") end
  hp(14, 4, "4"); hp(19, 6, "4"); hp(12, 7, "c"); hp(20, 3, "c")
  hp(16, 5, "4"); hp(15, 5, "4"); hp(17, 5, "4"); hp(16, 4, "4"); hp(16, 6, "4")
  -- Brim.
  rrect(img, ox + 1, hy + 9, ox + 30, hy + 12, "0", 2)
  rect(img, ox + 3, hy + 10, ox + 28, hy + 10, "a")
  rect(img, ox + 3, hy + 11, ox + 28, hy + 11, "9")
  -- Bell on the tip.
  local tip = center(0)
  hp(tip + 1, -1, "0"); hp(tip + 2, -1, "0")
  rect(img, ox + tip + 2, hy - 2, ox + tip + 4, hy, "0")
  hp(tip + 3, -1, "4")
end

-- Space weirdos. Each draws into a 28x32 box with top-left (x, y). ----------------

local weirdos = {}

-- A floppy disk that bites.
function weirdos.floppy(img, x, y, t)
  local bob = wave(t, 8, 1)
  local open = ({ 0, 0, 0, 0, 0, 0, 0, 0, 1, 3, 5, 5, 4, 1, 0, 0 })[t + 1]
  local disk = Image(20, 20, ColorMode.RGB)
  rrect(disk, 0, 0, 19, 19, "0", 1)
  rect(disk, 1, 1, 18, 18, "9")
  rect(disk, 1, 1, 1, 18, "a")
  px(disk, 19, 1, "0"); disk:drawPixel(19, 0, 0); disk:drawPixel(18, 0, 0)
  rect(disk, 5, 1, 14, 7, "d")
  rect(disk, 5, 1, 5, 7, "c")
  -- Angry glowing eyes on the shutter.
  rect(disk, 6, 3, 8, 6, "0"); rect(disk, 11, 3, 13, 6, "0")
  px(disk, 7, 5, "4"); px(disk, 12, 5, "4"); px(disk, 7, 4, "3"); px(disk, 12, 4, "3")
  px(disk, 6, 2, "0"); px(disk, 13, 2, "0")
  -- Label.
  rect(disk, 3, 11, 16, 18, "c")
  rect(disk, 4, 13, 14, 13, "d"); rect(disk, 4, 15, 12, 15, "d"); rect(disk, 4, 17, 15, 17, "d")
  px(disk, 15, 12, "2")

  local X, Y = x + 4, y + 10 + bob
  -- Mouth interior when open.
  if open > 0 then
    rect(img, X + 1, Y + 10 - open, X + 18, Y + 10, "0")
    rect(img, X + 2, Y + 11 - open, X + 17, Y + 10, "1")
    for tx = 2, 16, 3 do
      px(img, X + tx, Y + 11 - open, "c"); px(img, X + tx + 1, Y + 11 - open, "c")
      px(img, X + tx + 1, Y + 10, "c")
    end
  end
  -- Upper jaw lifts, lower jaw stays.
  for yy = 0, 19 do
    local dy = yy < 10 and -open or 0
    for xx = 0, 19 do
      local v = disk:getPixel(xx, yy)
      if app.pixelColor.rgbaA(v) > 0 then img:drawPixel(X + xx, Y + yy + dy, v) end
    end
  end
  -- Tongue.
  if open >= 3 then
    rect(img, X + 7, Y + 9, X + 10, Y + 15, "0")
    rect(img, X + 8, Y + 9, X + 9, Y + 14, "3")
    px(img, X + 8, Y + 14, "2")
    px(img, X + 13, Y + 11 + (t % 2), "b")
  end
end

-- A UFO beaming up a cow that does not want to go.
function weirdos.ufo(img, x, y, t)
  local cx = x + 14
  local sy = y + 2 + wave(t, 8, 1)
  -- Beam.
  for yy = sy + 9, y + 31 do
    local half = 3 + round((yy - sy - 9) * 0.4)
    for xx = cx - half, cx + half do
      if xx == cx - half or xx == cx + half then px(img, xx, yy, "6")
      elseif (yy + t) % 3 == 0 and (xx + yy) % 2 == 0 then px(img, xx, yy, "5") end
    end
  end
  -- Cow, struggling.
  local cy = y + 20 + wave(t, 16, 3)
  local ccx = cx - 1 + wave(t, 4, 1)
  rect(img, ccx - 6, cy - 1, ccx + 3, cy + 4, "0")
  rect(img, ccx - 5, cy, ccx + 2, cy + 3, "c")
  px(img, ccx - 4, cy, "0"); px(img, ccx - 3, cy + 1, "0"); px(img, ccx, cy + 2, "0"); px(img, ccx + 1, cy + 2, "0")
  rect(img, ccx + 3, cy - 2, ccx + 7, cy + 2, "0")
  rect(img, ccx + 4, cy - 1, ccx + 6, cy + 1, "c")
  px(img, ccx + 6, cy + 1, "3"); px(img, ccx + 7, cy + 1, "3"); px(img, ccx + 5, cy - 1, "0")
  px(img, ccx + 4, cy - 3, "4"); px(img, ccx + 6, cy - 3, "4")
  for i, lx in ipairs({ -5, -3, 0, 2 }) do
    local kick = ((t + i) % 2 == 0) and 1 or 0
    px(img, ccx + lx + kick, cy + 5, "0"); px(img, ccx + lx + kick, cy + 6, "0")
  end
  px(img, ccx - 7, cy + (t % 2), "0")
  -- Saucer.
  ellipse(img, cx, sy + 4, 6, 5, "0", "top")
  ellipse(img, cx, sy + 4, 5, 4, "b", "top")
  -- Little green pilot.
  rect(img, cx - 1, sy + 1, cx + 1, sy + 3, "5")
  px(img, cx - 1, sy + 2, "0"); px(img, cx + 1, sy + 2, "0"); px(img, cx, sy, "5")
  px(img, cx - 3, sy + 1, "c")
  ellipse(img, cx, sy + 6, 13, 3.5, "0")
  ellipse(img, cx, sy + 6, 12, 2.5, "d")
  rect(img, cx - 10, sy + 7, cx + 10, sy + 7, "e")
  for i = -2, 2 do
    local k = ({ "2", "4", "5" })[(i + t) % 3 + 1]
    px(img, cx + i * 4, sy + 6, k)
  end
end

-- A worried ringed planet with a moon it does not trust.
function weirdos.planet(img, x, y, t)
  local cx, cy = x + 14, y + 16 + wave(t, 16, 1, 2)
  local a = t / N * TAU
  local mx, my = cx + round(math.cos(a) * 12), cy + round(math.sin(a) * 9) - 2
  local function moon() ball(img, mx, my, 2, "d"); px(img, mx - 1, my - 1, "c"); px(img, mx + 1, my, "e") end
  if math.sin(a) < 0 then moon() end
  ellipse(img, cx, cy, 14, 4, "0", "top")
  ellipse(img, cx, cy, 13, 3, "4", "top")
  ellipse(img, cx, cy, 10, 1.5, "0", "top")
  ball(img, cx, cy, 8, "6")
  for yy = -8, 8 do
    for xx = -8, 8 do
      if xx * xx + yy * yy <= 64 then
        if (yy + 8) % 5 == 0 then px(img, cx + xx, cy + yy, "5")
        elseif (yy + 8) % 5 == 3 then px(img, cx + xx, cy + yy, "7") end
      end
    end
  end
  -- Face: eyes follow the moon.
  local look = (mx > cx) and 1 or 0
  rect(img, cx - 5, cy - 3, cx - 2, cy, "c"); rect(img, cx + 2, cy - 3, cx + 5, cy, "c")
  rect(img, cx - 4 + look, cy - 2, cx - 3 + look, cy - 1, "0")
  rect(img, cx + 3 + look, cy - 2, cx + 4 + look, cy - 1, "0")
  px(img, cx - 6, cy + 2, "3"); px(img, cx + 6, cy + 2, "3")
  if math.sin(a) > 0.3 then
    rect(img, cx - 1, cy + 2, cx + 1, cy + 4, "0"); px(img, cx, cy + 3, "2")
  else
    rect(img, cx - 2, cy + 3, cx + 2, cy + 3, "0"); px(img, cx - 2, cy + 2, "0"); px(img, cx + 2, cy + 2, "0")
  end
  ellipse(img, cx, cy, 14, 4, "0", "bottom")
  ellipse(img, cx, cy, 13, 3, "4", "bottom")
  ellipse(img, cx, cy, 10, 1.5, "3", "bottom")
  ellipse(img, cx, cy - 1, 9, 1, "6", "bottom")
  if math.sin(a) >= 0 then moon() end
end

-- A three-eyed space jellyfish.
function weirdos.jelly(img, x, y, t)
  local cx, cy = x + 14, y + 10 + wave(t, 8, 2)
  local p = (t % 4 < 2) and 0 or 1
  -- Tentacles.
  for i = -2, 2 do
    local bx = cx + i * 3
    local len = 13 + (i * i) % 3
    for j = 1, len do
      local xx = bx + round(math.sin(j * 0.5 + t / 8 * TAU + i) * 1.5)
      px(img, xx, cy + j, (j % 3 == 0) and "4" or "3")
      if j == len then px(img, xx, cy + j + 1, "b") end
    end
  end
  ellipse(img, cx, cy, 10 - p, 8 + p, "0", "top")
  ellipse(img, cx, cy, 9 - p, 7 + p, "2", "top")
  ellipse(img, cx - 2, cy - 2, 5, 3, "3", "top")
  px(img, cx - 5, cy - 4, "c"); px(img, cx - 4, cy - 5, "c")
  -- Frilly skirt.
  for xx = cx - 9 + p, cx + 9 - p do
    px(img, xx, cy + 1, ((xx + t) % 3 == 0) and "4" or "3")
    if (xx + t) % 2 == 0 then px(img, xx, cy + 2, "0") end
  end
  -- Three eyes, blinking out of sync.
  for i = -1, 1 do
    local ex, ey = cx + i * 4, cy - 3 + math.abs(i)
    if (t + i * 5 + 16) % 16 == 3 then
      rect(img, ex - 1, ey, ex + 1, ey, "0")
    else
      rect(img, ex - 1, ey - 1, ex + 1, ey + 1, "c")
      px(img, ex + ((i == 0) and 0 or -i), ey, "0")
    end
  end
end

-- An eyeball on tentacles.
function weirdos.eyeball(img, x, y, t)
  local cx, cy = x + 14, y + 11 + wave(t, 16, 2, 3)
  for i = -1, 2 do
    local bx = cx + i * 4 - 1
    for j = 5, 18 do
      local xx = bx + round(math.sin(j * 0.6 - t / 8 * TAU + i * 2) * 1.6)
      px(img, xx - 1, cy + j, "0"); px(img, xx + 1, cy + j, "0")
      px(img, xx, cy + j, (j % 3 == 0) and "3" or "2")
    end
  end
  ball(img, cx, cy, 7, "c")
  for yy = -7, 7 do
    for xx = -7, 7 do
      local d = xx * xx + yy * yy
      if d <= 49 and d > 30 and xx + yy > 2 then px(img, cx + xx, cy + yy, "d") end
    end
  end
  px(img, cx - 6, cy + 1, "2"); px(img, cx - 5, cy + 2, "2"); px(img, cx - 5, cy + 3, "2")
  px(img, cx + 4, cy - 5, "2"); px(img, cx + 5, cy - 4, "2")
  local look = { { 0, 0 }, { 2, 0 }, { 3, -1 }, { 3, -1 }, { 0, 0 }, { -3, 1 }, { -3, 2 }, { -1, 3 } }
  local l = look[math.floor(t / 2) % #look + 1]
  disc(img, cx + l[1], cy + l[2], 3, "a")
  disc(img, cx + l[1], cy + l[2], 1, "0")
  px(img, cx + l[1] - 1, cy + l[2] - 2, "c")
end

-- A rubber duck in a space helmet.
function weirdos.duck(img, x, y, t)
  local cx, cy = x + 14, y + 12 + wave(t, 16, 2, 5)
  local tilt = wave(t, 16, 1)
  -- Suit.
  rrect(img, cx - 7, cy + 6, cx + 7, cy + 17, "0", 2)
  rrect(img, cx - 6, cy + 7, cx + 6, cy + 16, "c", 2)
  rect(img, cx - 6, cy + 13, cx + 6, cy + 13, "d")
  rect(img, cx - 2, cy + 9, cx + 1, cy + 11, "2"); px(img, cx - 1, cy + 9, "3")
  -- Jetpack puffs.
  px(img, cx - 8, cy + 16 + (t % 3), "d"); px(img, cx + 8, cy + 16 + ((t + 1) % 3), "d")
  -- Helmet.
  ball(img, cx, cy, 8, "f")
  disc(img, cx + tilt, cy + 1, 4, "4")
  px(img, cx + tilt - 2, cy - 1, "c")
  px(img, cx + tilt + 1, cy, "0")
  rect(img, cx + tilt + 3, cy + 1, cx + tilt + 6, cy + 2, "3")
  rect(img, cx + tilt + 3, cy + 3, cx + tilt + 5, cy + 3, "2")
  px(img, cx - 5, cy - 4, "c"); px(img, cx - 4, cy - 5, "c"); px(img, cx - 6, cy - 2, "d")
  -- Antenna.
  rect(img, cx + 4, cy - 12, cx + 4, cy - 8, "0")
  ball(img, cx + 4, cy - 13, 1, (t % 8 < 4) and "2" or "4")
end

-- Output -----------------------------------------------------------------------

local function scaled(img, s)
  local big = Image(img.width * s, img.height * s, img.colorMode)
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local v = img:getPixel(x, y)
      for dy = 0, s - 1 do
        for dx = 0, s - 1 do big:drawPixel(x * s + dx, y * s + dy, v) end
      end
    end
  end
  return big
end

-- Save the .aseprite source, then PNG stills and animated GIFs at each scale.
local function save(spr, name, scales)
  spr:saveCopyAs(app.fs.joinPath(out, name .. ".aseprite"))
  for _, s in ipairs(scales) do
    local suffix = s == 1 and "" or ("@" .. s .. "x")
    local still = Image(spr.width, spr.height, spr.colorMode)
    still:drawSprite(spr, 1)
    scaled(still, s):saveAs(app.fs.joinPath(out, name .. suffix .. ".png"))
    if #spr.frames > 1 then
      local big = Sprite(spr.width * s, spr.height * s, spr.colorMode)
      for i = 1, #spr.frames do
        if i > 1 then big:newEmptyFrame() end
        local img = Image(spr.width, spr.height, spr.colorMode)
        img:drawSprite(spr, i)
        big:newCel(big.layers[1], i, scaled(img, s), Point(0, 0))
        big.frames[i].duration = spr.frames[i].duration
      end
      big:saveCopyAs(app.fs.joinPath(out, name .. suffix .. ".gif"))
      big:close()
    end
  end
  spr:close()
end

-- Icon: the wizard's head in a nebula tile.
do
  local spr = Sprite(32, 32, ColorMode.RGB)
  local img = Image(32, 32, ColorMode.RGB)
  nebula(img, { { 28, 4, 22, "1", "8" }, { 2, 30, 18, "8", "8" } })
  stars(img, 10, 0, 3)
  wizard(img, 0, 3, 0, true)
  -- Frame drawn last so it crops cleanly.
  rect(img, 0, 0, 31, 0, "0"); rect(img, 0, 31, 31, 31, "0")
  rect(img, 0, 0, 0, 31, "0"); rect(img, 31, 0, 31, 31, "0")
  for _, c in ipairs({ { 0, 0 }, { 31, 0 }, { 0, 31 }, { 31, 31 } }) do img:drawPixel(c[1], c[2], 0) end
  spr.cels[1].image = img
  save(spr, "icon", { 1, 4, 8 })
end

-- Banner: a 16-frame loop.
do
  local W, H = 240, 72
  local spr = Sprite(W, H, ColorMode.RGB)
  for _ = 2, N do spr:newEmptyFrame() end

  local bg = Image(W, H, ColorMode.RGB)
  nebula(bg, {
    { 30, 10, 60, "8", "8" },
    { 170, 72, 90, "1", "8" },
    { 120, 0, 40, "1", "8" },
  })

  -- One frame of the scene. Without bg it draws on a transparent image.
  local function frame(t, withBg)
    local img = Image(W, H, ColorMode.RGB)
    if withBg then img:drawImage(bg, Point(0, 0)) end
    stars(img, 70, t, 11)

    -- A sleepy moon in the corner, snoring.
    local mcx, mcy = 228, 4
    ball(img, mcx, mcy, 14, "d")
    for y = -14, 14 do
      for x = -14, 14 do
        if x * x + y * y <= 196 and (x + 5) ^ 2 + (y - 5) ^ 2 > 150 then px(img, mcx + x, mcy + y, "e") end
      end
    end
    ball(img, mcx + 4, mcy - 6, 2, "e"); ball(img, mcx + 8, mcy + 4, 1, "e")
    for _, ex in ipairs({ -8, -2 }) do
      px(img, mcx + ex, mcy + 6, "0"); px(img, mcx + ex + 1, mcy + 7, "0"); px(img, mcx + ex + 2, mcy + 6, "0")
    end
    local snore = (t % 8 < 4) and 1 or 2
    ball(img, mcx - 4, mcy + 11, snore - 1, "0")
    for k = 0, 1 do
      local age = (t + k * 8) % N
      local zx, zy = mcx - 16 - math.floor(age / 2), mcy + 14 - age
      if zy > -3 then stamp(img, zx, zy, { "ccc", ".c.", "ccc" }) end
    end

    -- Shooting star.
    if t < 6 then
      local sx, sy = 200 - t * 22, 2 + t * 4
      for i = 0, 7 do
        px(img, sx + i * 2, sy - i, i < 2 and "c" or i < 5 and "d" or "e")
        px(img, sx + i * 2 + 1, sy - i, i < 3 and "d" or "e")
      end
    end

    -- The wizard hovers.
    local wx, wy = 6, 8 + wave(t, 16, 2)
    local tipx, tipy = wx + 39, wy + 20

    -- Spell stream: sparkles fly from the wand along the rune line.
    local heads = {}
    for k = 0, 7 do
      local age = (t + k * 2) % N
      local x = tipx + age * 12
      local y = 29 + round(math.sin(age * 0.9) * 3)
      if age == 0 then y = tipy end
      heads[#heads + 1] = x
      local kk = ({ "4", "c", "b", "5" })[k % 4 + 1]
      px(img, x, y, kk)
      if age % 2 == 0 then
        px(img, x - 1, y, kk); px(img, x + 1, y, kk); px(img, x, y - 1, kk); px(img, x, y + 1, kk)
      end
    end

    -- Runes light up as the spell passes.
    for i = 0, 27 do
      local rx = 60 + i * 5
      local glow = "7"
      for _, hx in ipairs(heads) do
        local d = math.abs(hx - rx - 1)
        if d <= 3 then glow = "5" elseif d <= 7 and glow == "7" then glow = "b" end
      end
      rune(img, rx, 27, hash(i, 5) % #runes + 1, glow)
    end

    -- The weirdos.
    local order = { "floppy", "ufo", "planet", "jelly", "eyeball", "duck" }
    for i, name in ipairs(order) do
      weirdos[name](img, 56 + (i - 1) * 30, 36, t)
    end

    wizard(img, wx, wy, t)

    -- Title, with a wave and a glitch twice per loop.
    local title = Image(W, H, ColorMode.RGB)
    local s = "ASEPRITE MCP"
    local x = 60
    for i = 1, #s do
      local ch = s:sub(i, i)
      local dy = wave(t, 16, 1.5, -i * 0.6)
      if i > 9 then
        glyph2x(title, x, 6 + dy, ch, { "4", "4", "3", "2" }, "1")
      else
        glyph2x(title, x, 6 + dy, ch, { "c", "c", "b", "a" }, "1")
      end
      x = x + 12
    end
    local glitch = (t == 5 or t == 12)
    for y = 0, H - 1 do
      local dx = 0
      if glitch then
        if (y + t) % 7 < 2 then dx = 5 elseif y % 4 == 0 then dx = -2 end
      end
      for xx = 0, W - 1 do
        local v = title:getPixel(xx, y)
        if app.pixelColor.rgbaA(v) > 0 then
          if glitch then
            px(img, xx - 3 + dx, y, "2")
            px(img, xx + 3 + dx, y, "b")
          end
        end
      end
      for xx = 0, W - 1 do
        local v = title:getPixel(xx, y)
        if app.pixelColor.rgbaA(v) > 0 and xx + dx >= 0 and xx + dx < W then
          img:drawPixel(xx + dx, y, v)
        end
      end
    end

    return img
  end

  for t = 0, N - 1 do
    spr:newCel(spr.layers[1], t + 1, frame(t, true), Point(0, 0))
    spr.frames[t + 1].duration = 0.09
  end
  save(spr, "banner", { 1, 4 })

  -- Social preview card, 2:1, for GitHub's repository settings.
  local CW, CH = 320, 160
  local card = Sprite(CW, CH, ColorMode.RGB)
  local cimg = Image(CW, CH, ColorMode.RGB)
  nebula(cimg, {
    { 40, 20, 110, "8", "8" },
    { 250, 160, 150, "1", "8" },
    { 170, 0, 70, "1", "8" },
    { 0, 150, 60, "1", "8" },
  })
  stars(cimg, 120, 0, 29)
  cimg:drawImage(frame(0, false), Point(40, 44))
  -- Rune borders above and below.
  for i = 0, 59 do
    rune(cimg, 10 + i * 5, 14, hash(i, 9) % #runes + 1, (i % 7 == 0) and "5" or "7")
    rune(cimg, 10 + i * 5, CH - 19, hash(i, 13) % #runes + 1, (i % 5 == 0) and "b" or "7")
  end
  card.cels[1].image = cimg
  save(card, "social", { 4 })
end
