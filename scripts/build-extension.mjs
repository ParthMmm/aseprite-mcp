// Packs extension/ and LICENSE into dist/aseprite-mcp.aseprite-extension: a store-only zip, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (path) => fileURLToPath(new URL(path, new URL("..", import.meta.url)));

function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Little-endian record from [byteWidth, value] pairs. */
function record(fields) {
  const buf = Buffer.alloc(fields.reduce((n, [width]) => n + width, 0));
  let o = 0;
  for (const [width, value] of fields) {
    if (width === 4) buf.writeUInt32LE(value, o);
    else buf.writeUInt16LE(value, o);
    o += width;
  }
  return buf;
}

const VERSION = 20;
const UTF8_NAMES = 1 << 11;
// 1980-01-01 00:00, the earliest DOS date, so every build is byte-identical.
const STAMP = [[2, 0], [2, 0x21]];

/** @param {{ name: string, data: Buffer }[]} files */
function storeZip(files) {
  const body = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const shared = [[2, UTF8_NAMES], [2, 0], ...STAMP, [4, crc32(data)], [4, data.length], [4, data.length], [2, nameBytes.length], [2, 0]];
    const head = Buffer.concat([record([[4, 0x04034b50], [2, VERSION], ...shared]), nameBytes]);
    directory.push(record([[4, 0x02014b50], [2, VERSION], [2, VERSION], ...shared, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), nameBytes);
    body.push(head, data);
    offset += head.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const tail = record([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, dir.length], [4, offset], [2, 0]]);
  return Buffer.concat([...body, dir, tail]);
}

const files = readdirSync(at("extension"))
  .filter((name) => !name.startsWith("."))
  .sort()
  .map((name) => ({ name, data: readFileSync(at(`extension/${name}`)) }));
files.push({ name: "LICENSE", data: readFileSync(at("LICENSE")) });

const target = at("dist/aseprite-mcp.aseprite-extension");
mkdirSync(at("dist"), { recursive: true });
writeFileSync(target, storeZip(files));
console.log(`Wrote ${target.slice(root.length)} with ${files.map((f) => f.name).join(", ")}`);
