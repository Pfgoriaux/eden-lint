import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { readCaptures, repositoryKey, validateCapture } from "./capture.mjs";

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
  if (entry?.constructor !== Object) return "entry must be an object";

  if (!isString(entry.text) || entry.text === "")
    return "text must be a non-empty string";

  if (!TAGS.includes(entry.tag))
    return `unknown tag: ${entry.tag ?? "(missing)"} (valid: ${TAGS.join(", ")})`;

  if (!SEVERITIES.includes(entry.severity))
    return `unknown severity: ${entry.severity ?? "(missing)"} (valid: ${SEVERITIES.join(", ")})`;

  if (entry.state !== undefined && !STATES.includes(entry.state))
    return `unknown state: ${entry.state} (valid: ${STATES.join(", ")})`;

  const error = validateEnforcement(entry);

  if (error !== null) return error;

  if (entry.captureVersion !== undefined) return validateCaptureMetadata(entry);

  return null;
}

function validateEnforcement(entry) {
  for (const field of ["pattern", "glob"])
    if (entry[field] !== undefined && !isString(entry[field]))
      return `${field} must be a string`;

  if (entry.pattern !== undefined) {
    try {
      compilePattern(entry.pattern);
    } catch (error) {
      return `pattern does not compile: ${error.message}`;
    }
  }

  try {
    globToRegex(entry.glob ?? DEFAULT_GLOB);
  } catch (error) {
    return `glob does not compile: ${error.message}`;
  }

  return null;
}

function validateCaptureMetadata(entry) {
  try {
    const { section, path, line, ...provenance } = entry.provenance;

    const finding = {
      section,
      path,
      line,
      text: entry.text,
      severity: entry.severity,
    };

    if (entry.prescription !== undefined)
      finding.prescription = entry.prescription;

    const capture = validateCapture({
      captureVersion: entry.captureVersion,
      id: entry.id,
      createdAt: entry.createdAt,
      source: entry.source,
      finding,
      provenance,
    });

    if (entry.tag !== (section === "findings" ? "safety" : "style"))
      return "capture tag does not match section";

    if (entry.text !== capture.finding.text)
      return "capture text must be normalized";

    if (!STATES.includes(entry.state)) return "capture entry needs a state";

    return null;
  } catch (error) {
    return `invalid capture metadata: ${error.message}`;
  }
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

function globStar(glob, index) {
  if (glob[index + 1] !== "*") return ["[^/]*", index + 1];

  if (glob[index + 2] === "/") return ["(?:.*/)?", index + 3];

  return [".*", index + 2];
}

function globBrace(glob, index) {
  const end = glob.indexOf("}", index);

  if (end === -1) throw new Error(`unclosed { in glob: ${glob}`);

  const alternatives = glob
    .slice(index + 1, end)
    .split(",")
    .map((alternative) => alternative.split("").map(escapeChar).join(""));

  return [`(?:${alternatives.join("|")})`, end + 1];
}

function globClass(glob, index) {
  const end = glob.indexOf("]", index);

  if (end === -1) throw new Error(`unclosed [ in glob: ${glob}`);

  const body = glob.slice(index + 1, end);
  const negated = body.startsWith("!") ? "^" : "";

  return [`[${negated}${negated === "" ? body : body.slice(1)}]`, end + 1];
}

export function globToRegex(glob) {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    let part;

    if (char === "*") [part, index] = globStar(glob, index);
    else if (char === "?") [part, index] = ["[^/]", index + 1];
    else if (char === "{") [part, index] = globBrace(glob, index);
    else if (char === "[") [part, index] = globClass(glob, index);
    else [part, index] = [escapeChar(char), index + 1];

    source += part;
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

function problemAt(line) {
  let entry;

  try {
    entry = JSON.parse(line);
  } catch (error) {
    return error.message;
  }

  if (!isString(entry?.id) || entry.id === "")
    return "id must be a non-empty string";

  return validateEntry(entry);
}

/**
 * Read and validate the ledger. Returns `{ code, entries }`: `entries` is
 * null when the file is missing (code 0) or any line is invalid (code 1,
 * problems already printed as `path:line: message`).
 */
function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return { code: 0, entries: null };

  let text;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(ledgerPath),
    );
  } catch (error) {
    console.error(`${ledgerPath}: ${error.message}`);

    return { code: 1, entries: null };
  }

  const latest = new Map();
  let failed = false;
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (line === "") continue;

    const problem = problemAt(line);

    if (problem !== null) {
      console.error(`${ledgerPath}:${index + 1}: ${problem}`);
      failed = true;
      continue;
    }

    const entry = JSON.parse(line);
    latest.set(entry.id, entry);
  }

  if (failed) return { code: 1, entries: null };

  return { code: 0, entries: [...latest.values()] };
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
  const parsed = parseFlags(args, ["state", "tag", "from"]);

  if (parsed.error !== undefined) {
    console.error(`ledger list: ${parsed.error}`);

    return 2;
  }

  if (parsed.flags.from !== undefined) return listCaptures(parsed.flags);

  const { code, entries } = readLedger(ledgerPath);

  if (entries === null) {
    if (code === 0) console.log(`ledger: ${LEDGER_FILE} not found`);

    return code;
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

function listCaptures(flags) {
  if (flags.state !== undefined || flags.tag !== undefined) {
    console.error(
      "ledger list: --from cannot be combined with --state or --tag",
    );

    return 2;
  }

  try {
    const captures = readCaptures(flags.from);

    for (const { id, finding } of captures)
      console.log(
        `${id}  ${finding.section} ${finding.severity} ${finding.path}:${finding.line} ${finding.text}`,
      );

    return 0;
  } catch (error) {
    console.error(`ledger list: ${error.message}`);

    return 1;
  }
}

function mutationEntries(ledgerPath) {
  const stat = lstatSync(ledgerPath, { throwIfNoEntry: false });

  if (stat !== undefined && !stat.isFile())
    throw new Error("destination must be a regular file, not a symlink");

  const { code, entries } = readLedger(ledgerPath);

  if (code !== 0) throw new Error("invalid destination ledger");

  return entries ?? [];
}

function entryFromCapture(capture) {
  const { section, path, line, text, severity, prescription } = capture.finding;

  const entry = {
    id: capture.id,
    text,
    tag: section === "findings" ? "safety" : "style",
    severity: severity === "blocker" ? "major" : severity,
    state: "open",
    createdAt: capture.createdAt,
    source: capture.source,
    captureVersion: capture.captureVersion,
    provenance: { ...capture.provenance, section, path, line },
  };

  if (prescription !== undefined) entry.prescription = prescription;

  return entry;
}

function appendValidatedEntry(ledgerPath, entry) {
  const error = validateEntry(entry);

  if (error !== null) throw new Error(error);

  const previous = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
    : "";

  const separator = previous === "" || previous.endsWith("\n") ? "" : "\n";

  appendFileSync(ledgerPath, `${separator}${JSON.stringify(entry)}\n`);
}

function importCapture(ledgerPath, flags, repoKey) {
  const captures = readCaptures(flags.from);
  const capture = captures.find((record) => record.id === flags.id);

  if (capture === undefined) throw new Error(`no capture with id ${flags.id}`);

  if (capture.provenance.repoKey !== repoKey)
    throw new Error("capture belongs to another clone or repository");

  const entries = mutationEntries(ledgerPath);

  if (entries.some((existing) => existing.id === capture.id)) {
    console.log(`ledger: ${capture.id} already exists; unchanged`);

    return;
  }

  appendValidatedEntry(ledgerPath, entryFromCapture(capture));
  console.log(`ledger: imported ${capture.id} (unenforced)`);
}

function activateEntry(ledgerPath, flags, repoKey) {
  const entries = mutationEntries(ledgerPath);
  const entry = entries.find((candidate) => candidate.id === flags.id);

  if (entry?.state !== "open")
    throw new Error("activation requires an existing open entry");

  if (
    entry.captureVersion !== undefined &&
    entry.provenance.repoKey !== repoKey
  )
    throw new Error("capture belongs to another clone or repository");

  appendValidatedEntry(ledgerPath, {
    ...entry,
    pattern: flags.pattern,
    glob: flags.glob,
  });
  console.log(`ledger: activated ${entry.id}`);
}

function captureMutation(ledgerPath, cwd, args, kind) {
  const required =
    kind === "import" ? ["from", "id"] : ["id", "pattern", "glob"];

  const parsed = parseFlags(args, required);

  if (parsed.error !== undefined) {
    console.error(`ledger ${kind}: ${parsed.error}`);

    return 2;
  }

  const { flags } = parsed;

  if (
    required.some((name) => !isString(flags[name]) || flags[name].trim() === "")
  ) {
    console.error(
      `ledger ${kind}: explicit nonempty ${required.map((name) => `--${name}`).join(", ")} required`,
    );

    return 2;
  }

  try {
    const repoKey = repositoryKey(cwd);

    if (kind === "import") importCapture(ledgerPath, flags, repoKey);
    else activateEntry(ledgerPath, flags, repoKey);

    return 0;
  } catch (error) {
    console.error(`ledger ${kind}: ${error.message}`);

    return 1;
  }
}

function isRegularFile(path) {
  if (!existsSync(path)) return false;

  // lstat, not stat: a symlink is never read, whatever it points to.
  return lstatSync(path).isFile();
}

function listFiles(cwd) {
  const git = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    {
      cwd,
      encoding: "utf8",
    },
  );

  if (git.error === undefined && git.status === 0)
    return git.stdout
      .split("\0")
      .filter((path) => path !== "")
      .filter((path) => isRegularFile(join(cwd, path)));

  return walk(cwd, "");
}

function walk(root, prefix) {
  const files = [];

  for (const name of readdirSync(join(root, prefix))) {
    if (SKIP_DIRS.has(name)) continue;

    const path = prefix === "" ? name : `${prefix}/${name}`;

    // lstat, not stat: symlinks are skipped, even to directories.
    const stats = lstatSync(join(root, path));

    if (stats.isDirectory()) files.push(...walk(root, path));
    else if (stats.isFile()) files.push(path);
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
  const { code, entries } = readLedger(ledgerPath);

  if (entries === null) {
    if (code === 0) console.log(`ledger: ${LEDGER_FILE} not found`);

    return code;
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

  const { code, entries } = readLedger(ledgerPath);

  if (entries === null) {
    if (code === 0) console.error(`ledger: ${LEDGER_FILE} not found`);

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
    case "import":
    case "activate":
      return captureMutation(ledgerPath, cwd, rest, sub);
    case "check":
      return checkPatterns(ledgerPath, cwd);
    case "promote":
      return appendStateChange(ledgerPath, rest, "promote");
    case "close":
      return appendStateChange(ledgerPath, rest, "close");
    default:
      console.error(
        `usage: eden-lint ledger <list|add|import|activate|check|promote|close> [flags]\nunknown subcommand: ${sub}`,
      );

      return 2;
  }
}
