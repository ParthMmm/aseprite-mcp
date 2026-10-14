// Saved helper code. lib(name, code) writes <dir>/<name>.js. Before a program runs, its top-level use("name") calls
// are resolved (libraries may use others) and the library sources are prepended, dependencies first, so the
// functions they declare are in scope. Error locations are mapped back to the program or the library.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { parse } from "acorn";
import type { Program } from "acorn";

const NAME = /^[a-z0-9_-]{1,40}$/u;

/** Parsed exactly as @opencode/codemode parses a program. */
const parseScript = (code: string): Program =>
  parse(code, {
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ecmaVersion: "latest",
    locations: true,
    sourceType: "script",
  });

const checkName = (name: unknown): string => {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(
      `Library names are 1-40 characters of a-z, 0-9, _ and -; got ${JSON.stringify(name)}.`
    );
  }
  return name;
};

/** Names in top-level use("name") or await use("name") statements. */
const usesOf = (program: Program): string[] =>
  program.body.flatMap((statement) => {
    if (statement.type !== "ExpressionStatement") {
      return [];
    }
    const call =
      statement.expression.type === "AwaitExpression"
        ? statement.expression.argument
        : statement.expression;
    if (
      call.type !== "CallExpression" ||
      call.callee.type !== "Identifier" ||
      call.callee.name !== "use"
    ) {
      return [];
    }
    const [arg] = call.arguments;
    return arg?.type === "Literal" && typeof arg.value === "string"
      ? [arg.value]
      : [];
  });

export const listLibs = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir).catch(() => []);
  return names
    .filter((n) => n.endsWith(".js"))
    .map((n) => n.slice(0, -3))
    .filter((n) => NAME.test(n))
    .toSorted();
};

export const readLib = async (dir: string, name: unknown): Promise<string> => {
  const safe = checkName(name);
  try {
    return await readFile(nodePath.join(dir, `${safe}.js`), "utf-8");
  } catch {
    const known = await listLibs(dir);
    throw new Error(
      `No library '${safe}'. Libraries: ${known.join(", ") || "none"}.`
    );
  }
};

/** Parses the code first, so a library with a syntax error is never saved. */
export const saveLib = async (
  dir: string,
  name: unknown,
  code: unknown
): Promise<string> => {
  const safe = checkName(name);
  if (typeof code !== "string" || !code.trim()) {
    throw new Error(`lib("${safe}", code): code must be a non-empty string.`);
  }
  let program: Program;
  try {
    program = parseScript(code);
  } catch (error) {
    const { line } = (error as { loc?: { line: number } }).loc ?? {};
    const message = String((error as Error).message).replace(
      / \(\d+:\d+\)$/u,
      ""
    );
    throw new Error(
      `lib("${safe}"): syntax error${line ? ` at line ${line}` : ""}: ${message}. Nothing was saved.`,
      { cause: error }
    );
  }
  if (program.body.some((s) => s.type === "ReturnStatement")) {
    throw new Error(
      `lib("${safe}"): a library cannot return at the top level; it would end the program that uses it.`
    );
  }
  await mkdir(dir, { recursive: true });
  const file = nodePath.join(dir, `${safe}.js`);
  await writeFile(file, code.endsWith("\n") ? code : `${code}\n`);
  return file;
};

/** One prepended library: its source occupies lines first..first + lines - 1 of the combined code. */
interface Segment {
  name: string;
  first: number;
  lines: number;
}

export interface Prepared {
  code: string;
  /** Libraries in the order they were prepended. */
  libraries: string[];
  segments: Segment[];
  /** Lines before the program's first line. */
  offset: number;
}

const resolveOrder = async (
  dir: string,
  roots: string[]
): Promise<{ name: string; source: string }[]> => {
  const order: { name: string; source: string }[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visitAll = async (names: string[], path: string[]): Promise<void> => {
    const [name, ...rest] = names;
    if (name === undefined) {
      return;
    }
    if (state.get(name) === "visiting") {
      throw new Error(
        `use: libraries use each other in a cycle: ${[...path, name].join(" -> ")}.`
      );
    }
    if (state.get(name) !== "done") {
      state.set(name, "visiting");
      let source: string;
      try {
        source = await readLib(dir, name);
      } catch (error) {
        const where = path.length ? ` in library '${path.at(-1)}'` : "";
        throw new Error(`use("${name}")${where}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      await visitAll(usesOf(parseScript(source)), [...path, name]);
      state.set(name, "done");
      order.push({ name, source });
    }
    await visitAll(rest, path);
  };
  await visitAll(roots, []);
  return order;
};

/** The program with its used libraries prepended; a program that does not parse is left for codemode to report. */
export const prepare = async (
  dir: string | null,
  code: string
): Promise<Prepared> => {
  const plain: Prepared = { code, libraries: [], offset: 0, segments: [] };
  if (!code.includes("use(")) {
    return plain;
  }
  let roots: string[];
  try {
    roots = usesOf(parseScript(code));
  } catch {
    return plain;
  }
  if (!roots.length) {
    return plain;
  }
  if (dir === null) {
    throw new Error("use: saved libraries are turned off in this daemon.");
  }
  const order = await resolveOrder(dir, roots);
  const segments: Segment[] = [];
  let offset = 0;
  const parts = order.map(({ name, source }) => {
    const text = source.endsWith("\n") ? source : `${source}\n`;
    const lines = text.split("\n").length - 1;
    segments.push({ first: offset + 1, lines, name });
    offset += lines;
    return text;
  });
  return {
    code: parts.join("") + code,
    libraries: order.map((o) => o.name),
    offset,
    segments,
  };
};

export interface MappedError {
  kind: string;
  message: string;
  line?: number;
  library?: string;
}

/** Moves a combined-code line to the program or to the library that holds it. */
const place = (
  p: Prepared,
  line: number
): { line: number; library?: string } => {
  if (line > p.offset) {
    return { line: line - p.offset };
  }
  const seg = p.segments.find(
    (s) => line >= s.first && line < s.first + s.lines
  );
  return seg ? { library: seg.name, line: line - seg.first + 1 } : { line };
};

const describe = (at: { line: number; library?: string }, col: string) =>
  at.library
    ? `(library '${at.library}', line ${at.line}, col ${col})`
    : `(line ${at.line}, col ${col})`;

/** Rewrites "(line L, col C)" and acorn's "(L:C)" in a codemode error to program or library lines. */
export const mapError = (
  p: Prepared,
  error: {
    kind: string;
    message: string;
    location?: { line: number; column: number };
  }
): MappedError => {
  const { kind, location } = error;
  if (!p.segments.length) {
    return {
      kind,
      message: error.message,
      ...(location && { line: location.line }),
    };
  }
  let line = location?.line;
  const message = error.message
    .replaceAll(
      /\(line (?<line>\d+), col (?<col>\d+)\)/gu,
      (_, l: string, c: string) => {
        line ??= Number(l);
        return describe(place(p, Number(l)), c);
      }
    )
    .replace(/\((?<line>\d+):(?<col>\d+)\)$/u, (_, l: string, c: string) => {
      line ??= Number(l);
      return describe(place(p, Number(l)), String(Number(c) + 1));
    });
  return { kind, message, ...(line !== undefined && place(p, line)) };
};
