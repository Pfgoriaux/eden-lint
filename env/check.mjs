import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const registry = JSON.parse(
  readFileSync(new URL("./registry.json", import.meta.url), "utf8"),
);

const bannedByLength = Object.keys(registry.banned).sort(
  (a, b) => b.length - a.length,
);

const alwaysAllowed = new Set(registry.alwaysAllowed);

const MAX_FILE_BYTES = 1_000_000;

// Full identifier only: DB_URLS must not match as DB_URL.
const NAME = "([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])";

const QUOTED = `\\s*["'\`]${NAME}["'\`]\\s*`;

const CODE = [
  new RegExp(`(?:process|Bun|import\\.meta)\\.env\\.${NAME}`, "g"),
  new RegExp(`(?:process|Bun|import\\.meta)\\.env\\[${QUOTED}\\]`, "g"),
  new RegExp(`os\\.environ(?:\\.get\\(|\\[)${QUOTED}`, "g"),
  new RegExp(`os\\.getenv\\(${QUOTED}`, "g"),
];

// Covers `ENV A=1 B=2`, `export A=1`, `A=1 node app.js`, and `$A` / `${A}` references.
const SHELL = [
  new RegExp(`^\\s*(?:ENV|ARG|export)\\s+${NAME}`, "gm"),
  new RegExp(`(?:^|\\s)${NAME}=`, "gm"),
  new RegExp(`\\$\\{?${NAME}`, "g"),
];

const SOURCES = [
  {
    file: /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template)$/,
    patterns: [new RegExp(`^[ \\t#]*(?:export\\s+)?${NAME}=`, "gm")],
  },
  {
    file: /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/,
    patterns: [
      new RegExp(`\\$\\{${NAME}`, "g"),
      new RegExp(`^\\s*-?\\s*${NAME}\\s*[:=]`, "gm"),
    ],
  },
  { file: /(^|\/)Dockerfile[\w.-]*$|\.sh$/, patterns: SHELL },
  { file: /\.[cm]?[jt]sx?$|\.py$/, patterns: CODE },
];

/** Returns the canonical replacement for a banned name, or undefined when the name is fine. */
export function suggest(name) {
  if (alwaysAllowed.has(name)) return undefined;

  const banned = bannedByLength.find(
    (key) => name === key || name.endsWith(`_${key}`),
  );

  if (banned === undefined) return undefined;

  return name.slice(0, name.length - banned.length) + registry.banned[banned];
}

function listFiles(dir) {
  const output = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: dir, encoding: "utf8" },
  );

  return output.split("\0").filter((path) => path !== "");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function namesIn(text, patterns) {
  const found = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern))
      found.push({ name: match[1], line: lineOf(text, match.index) });
  }

  return found;
}

// lstat, not stat: a tracked `.env.example` symlink to a real `.env` must not be read.
function readSmallFile(path) {
  if (!existsSync(path)) return "";

  const stats = lstatSync(path);

  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return "";

  return readFileSync(path, "utf8");
}

function loadSettings(dir) {
  const path = join(dir, ".eden-lint.json");

  const env = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).env
    : undefined;

  return { allow: env?.allow ?? {}, ignorePaths: env?.ignorePaths ?? [] };
}

function scannedFiles(dir, ignorePaths) {
  return listFiles(dir).flatMap((file) => {
    const source = SOURCES.find((candidate) => candidate.file.test(file));
    const ignored = ignorePaths.some((prefix) => file.startsWith(prefix));

    return source === undefined || ignored ? [] : [{ file, source }];
  });
}

/** Scans a project directory and returns every banned env-var name with its location and replacement. */
export function checkEnv(dir) {
  const { allow, ignorePaths } = loadSettings(dir);
  const seen = new Set();
  const violations = [];

  for (const { file, source } of scannedFiles(dir, ignorePaths)) {
    for (const { name, line } of namesIn(
      readSmallFile(join(dir, file)),
      source.patterns,
    )) {
      const replacement = suggest(name);
      const key = `${file}:${line}:${name}`;

      if (replacement === undefined || name in allow || seen.has(key)) continue;
      seen.add(key);
      violations.push({ file, line, name, replacement });
    }
  }

  return violations;
}

export function runEnvCheck(dir) {
  const violations = checkEnv(dir);

  for (const v of violations)
    console.log(`${v.file}:${v.line}: ${v.name} -> use ${v.replacement}`);

  if (violations.length === 0) return 0;

  console.log(
    `\n${violations.length} env-var naming violation(s). Rename, or list the name with a reason under env.allow in .eden-lint.json.`,
  );

  return 1;
}
