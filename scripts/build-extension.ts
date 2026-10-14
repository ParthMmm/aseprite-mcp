// Packs extension/ and LICENSE into dist/aseprite-mcp.aseprite-extension: a store-only zip, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (path: string): string =>
  fileURLToPath(new URL(path, new URL("..", import.meta.url)));

type Field = [width: number, value: number];
interface ZipFile {
  name: string;
  data: Buffer;
}

const crc32 = (bytes: Uint8Array): number => {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c >>> 1) ^ (0xed_b8_83_20 & -(c & 1));
    }
  }
  return ~c >>> 0;
};

/** Little-endian record from [byteWidth, value] pairs. */
const record = (fields: Field[]): Buffer => {
  const buf = Buffer.alloc(fields.reduce((n, [width]) => n + width, 0));
  let o = 0;
  for (const [width, value] of fields) {
    if (width === 4) {
      buf.writeUInt32LE(value, o);
    } else {
      buf.writeUInt16LE(value, o);
    }
    o += width;
  }
  return buf;
};

const VERSION = 20;
const UTF8_NAMES = 1 << 11;
// 1980-01-01 00:00, the earliest DOS date, so every build is byte-identical.
const STAMP: Field[] = [
  [2, 0],
  [2, 0x21],
];

const storeZip = (files: ZipFile[]): Buffer => {
  const body: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf-8");
    const shared: Field[] = [
      [2, UTF8_NAMES],
      [2, 0],
      ...STAMP,
      [4, crc32(data)],
      [4, data.length],
      [4, data.length],
      [2, nameBytes.length],
      [2, 0],
    ];
    const head = Buffer.concat([
      record([[4, 0x04_03_4b_50], [2, VERSION], ...shared]),
      nameBytes,
    ]);
    directory.push(
      record([
        [4, 0x02_01_4b_50],
        [2, VERSION],
        [2, VERSION],
        ...shared,
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, offset],
      ]),
      nameBytes
    );
    body.push(head, data);
    offset += head.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const tail = record([
    [4, 0x06_05_4b_50],
    [2, 0],
    [2, 0],
    [2, files.length],
    [2, files.length],
    [4, dir.length],
    [4, offset],
    [2, 0],
  ]);
  return Buffer.concat([...body, dir, tail]);
};

const files = readdirSync(at("extension"))
  .filter((name) => !name.startsWith("."))
  .toSorted()
  .map((name) => ({ data: readFileSync(at(`extension/${name}`)), name }));
files.push({ data: readFileSync(at("LICENSE")), name: "LICENSE" });

const target = at("dist/aseprite-mcp.aseprite-extension");
mkdirSync(at("dist"), { recursive: true });
writeFileSync(target, storeZip(files));
console.log(
  `Wrote ${target.slice(root.length)} with ${files.map((f) => f.name).join(", ")}`
);
