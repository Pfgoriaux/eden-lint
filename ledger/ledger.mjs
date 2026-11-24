import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export const LEDGER_FILE = ".antislop.jsonl";

const TAGS = [
  "architecture",
  "tests",
  "api",
  "docs",
  "naming",
  "style",
  "safety",
  "other",
];

const SEVERITIES = ["minor", "major"];

const STATES = ["open", "promoted", "closed"];

const DEFAULT_GLOB = "**/*.{ts,tsx,js,mjs,mts}";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const OPTIONAL_FIELDS = ["pattern", "glob", "prescription", "source"];

/** Parse a ledger file's text into entries, keeping the latest line per id. */
export function parseLedger(text) {
  const latest = new Map();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "") continue;

    const entry = JSON.parse(trimmed);
    latest.set(entry.id, entry);
  }

  return [...latest.values()];
}

/** Return an error message for an invalid entry, or null when valid. */
export function validateEntry(entry) {
  if (!isString(entry.text) || entry.text === "")
    return "text must be a non-empty string";

  if (!TAGS.includes(entry.tag))
    return `unknown tag: ${entry.tag ?? "(missing)"} (valid: ${TAGS.join(", ")})`;

  if (!SEVERITIES.includes(entry.severity))
    return `unknown severity: ${entry.severity ?? "(missing)"} (valid: ${SEVERITIES.join(", ")})`;

  if (entry.state !== undefined && !STATES.includes(entry.state))
    return `unknown state: ${entry.state} (valid: ${STATES.join(", ")})`;

  if (entry.pattern !== undefined) {
    try {
      compilePattern(entry.pattern);
    } catch (error) {
      return `pattern does not compile: ${error.message}`;
    }
  }

  return null;
}

function isString(value) {
  return value?.constructor === String;
}

function compilePattern(source) {
  if (source.startsWith("(?-i)")) return new RegExp(source.slice(5));

  return new RegExp(source, "i");
}

function escapeChar(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

function globToRegex(glob) {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 2;

        if (glob[index] === "/") index += 1;
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else if (char === "{") {
      const end = glob.indexOf("}", index);

      const alternatives = glob
        .slice(index + 1, end)
        .split(",")
        .map((alternative) => alternative.split("").map(escapeChar).join(""));

      source += `(?:${alternatives.join("|")})`;
      index = end + 1;
    } else if (char === "[") {
      const end = glob.indexOf("]", index);
      source += glob.slice(index, end + 1);
      index = end + 1;
    } else {
      source += escapeChar(char);
      index += 1;
    }
  }

  return new RegExp(`^${source}$`);
}

/** Test an entry's pattern line by line on the files matching its glob. */
export function matchPattern(entry, files) {
  const regex = compilePattern(entry.pattern);
  const glob = globToRegex(entry.glob ?? DEFAULT_GLOB);
  const matches = [];

  for (const file of files) {
    if (!glob.test(file.path)) continue;

    const lines = file.text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index]))
        matches.push({ path: file.path, line: index + 1 });
    }
  }

  return matches;
}

/** Copy of the entry promoted to the rule that now enforces it. */
export function promoteEntry(entry, promotedTo) {
  return { ...entry, state: "promoted", promotedTo };
}

/** Copy of the entry closed, with the optional reason. */
export function closeEntry(entry, reason) {
  if (reason === undefined) return { ...entry, state: "closed" };

  return { ...entry, state: "closed", reason };
}

function parseFlags(args, names) {
  const flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) return { error: `unexpected argument: ${arg}` };

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);

    if (!names.includes(name)) return { error: `unknown flag: --${name}` };

    if (equals !== -1) {
      flags[name] = arg.slice(equals + 1);

      continue;
    }

    index += 1;

    if (args[index] === undefined) return { error: `--${name} needs a value` };

    flags[name] = args[index];
  }

  return { flags };
}

function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return null;

  return parseLedger(readFileSync(ledgerPath, "utf8"));
}

function addEntry(ledgerPath, args) {
  const parsed = parseFlags(args, [
    ...OPTIONAL_FIELDS,
    "text",
    "tag",
    "severity",
  ]);

  if (parsed.error !== undefined) {
    console.error(`ledger add: ${parsed.error}`);

    return 2;
  }

  const { flags } = parsed;

  if (flags.text === undefined || flags.tag === undefined) {
    console.error("ledger add: --text and --tag are required");

    return 2;
  }

  const entry = {
    id: `${Date.now()}-${randomBytes(2).toString("hex")}`,
    text: flags.text,
    tag: flags.tag,
    severity: flags.severity ?? "minor",
    state: "open",
    createdAt: new Date().toISOString(),
  };

  for (const field of OPTIONAL_FIELDS)
    if (flags[field] !== undefined) entry[field] = flags[field];

  const error = validateEntry(entry);

  if (error !== null) {
    console.error(`ledger add: ${error}`);

    return 1;
  }

  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  console.log(`ledger: added ${entry.id} to ${LEDGER_FILE}`);

  return 0;
}

function listEntries(ledgerPath, args) {
  const parsed = parseFlags(args, ["state", "tag"]);

  if (parsed.error !== undefined) {
    console.error(`ledger list: ${parsed.error}`);

    return 2;
  }

  const entries = readLedger(ledgerPath);

  if (entries === null) {
    console.log(`ledger: ${LEDGER_FILE} not found`);

    return 0;
  }

  const { flags } = parsed;

  const selected = entries.filter(
    (entry) =>
      (flags.state === undefined || entry.state === flags.state) &&
      (flags.tag === undefined || entry.tag === flags.tag),
  );

  for (const entry of selected) {
    const pattern =
      entry.pattern === undefined ? "" : ` pattern=${entry.pattern}`;

    console.log(
      `${entry.id}  ${entry.state.padEnd(9)} ${entry.tag.padEnd(12)} ${entry.severity.padEnd(6)} ${entry.text.slice(0, 100)}${pattern}`,
    );
  }

  return 0;
}

function listFiles(cwd) {
  const git = spawnSync("git", ["ls-files"], { cwd, encoding: "utf8" });

  if (git.error === undefined && git.status === 0)
    return git.stdout.split("\n").filter((line) => line !== "");

  return walk(cwd, "");
}

function walk(root, prefix) {
  const files = [];

  for (const name of readdirSync(join(root, prefix))) {
    if (SKIP_DIRS.has(name)) continue;

    const path = prefix === "" ? name : `${prefix}/${name}`;

    if (statSync(join(root, path)).isDirectory())
      files.push(...walk(root, path));
    else files.push(path);
  }

  return files;
}

function readFiles(cwd, entries) {
  if (entries.length === 0) return [];

  const globs = entries.map((entry) => globToRegex(entry.glob ?? DEFAULT_GLOB));

  const paths = listFiles(cwd).filter((path) =>
    globs.some((glob) => glob.test(path)),
  );

  return paths.map((path) => ({
    path,
    text: readFileSync(join(cwd, path), "utf8"),
  }));
}

function checkPatterns(ledgerPath, cwd) {
  const entries = readLedger(ledgerPath);

  if (entries === null) {
    console.log(`ledger: ${LEDGER_FILE} not found`);

    return 0;
  }

  const open = entries.filter((entry) => entry.state === "open");
  const enforced = open.filter((entry) => entry.pattern !== undefined);
  const files = readFiles(cwd, enforced);
  let failed = false;

  for (const entry of enforced) {
    for (const match of matchPattern(entry, files)) {
      console.log(`${match.path}:${match.line}: ${entry.id} ${entry.text}`);
      failed = true;
    }
  }

  console.log(
    `ledger: ${open.length - enforced.length} open entries without a pattern (unenforced).`,
  );

  return failed ? 1 : 0;
}

function appendStateChange(ledgerPath, args, kind) {
  const parsed = parseFlags(
    args,
    kind === "promote" ? ["id", "to"] : ["id", "reason"],
  );

  if (parsed.error !== undefined) {
    console.error(`ledger ${kind}: ${parsed.error}`);

    return 2;
  }

  const { flags } = parsed;

  if (
    flags.id === undefined ||
    (kind === "promote" && flags.to === undefined)
  ) {
    console.error(
      kind === "promote"
        ? "ledger promote: --id and --to are required"
        : "ledger close: --id is required",
    );

    return 2;
  }

  const entries = readLedger(ledgerPath);

  if (entries === null) {
    console.error(`ledger: ${LEDGER_FILE} not found`);

    return 1;
  }

  const entry = entries.find((candidate) => candidate.id === flags.id);

  if (entry === undefined) {
    console.error(`ledger: no entry with id ${flags.id}`);

    return 1;
  }

  const changed =
    kind === "promote"
      ? promoteEntry(entry, flags.to)
      : closeEntry(entry, flags.reason);

  appendFileSync(ledgerPath, `${JSON.stringify(changed)}\n`);
  console.log(
    `ledger: ${kind === "promote" ? "promoted" : "closed"} ${entry.id}`,
  );

  return 0;
}

/** Run `eden-lint ledger`. Returns the process exit code. */
export function runLedger(args, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const ledgerPath = join(cwd, LEDGER_FILE);
  const [sub = "", ...rest] = args;

  switch (sub) {
    case "add":
      return addEntry(ledgerPath, rest);
    case "list":
      return listEntries(ledgerPath, rest);
    case "check":
      return checkPatterns(ledgerPath, cwd);
    case "promote":
      return appendStateChange(ledgerPath, rest, "promote");
    case "close":
      return appendStateChange(ledgerPath, rest, "close");
    default:
      console.error(
        `usage: eden-lint ledger <list|add|check|promote|close> [flags]\nunknown subcommand: ${sub}`,
      );

      return 2;
  }
}
