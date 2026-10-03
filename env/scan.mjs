import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE_BYTES = 1_000_000;

// Full identifier only: DB_URLS must not match as DB_URL.
const NAME = "([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])";

const QUOTED = `\\s*["'\`]${NAME}["'\`]\\s*`;

// `read` patterns consume a value from the environment; `define` patterns declare or set one.
const read = (source, flags = "g") => ({
  role: "read",
  regex: new RegExp(source, flags),
});

const define = (source, flags = "gm") => ({
  role: "define",
  regex: new RegExp(source, flags),
});

export const EXAMPLE_FILE =
  /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template)$/;

export const REAL_ENV_FILE = /(^|\/)\.env(\.[\w-]+)*$/;

const SOURCES = [
  {
    kind: "example",
    file: EXAMPLE_FILE,
    patterns: [define(`^[ \\t#]*(?:export\\s+)?${NAME}=`)],
  },
  {
    kind: "compose",
    file: /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/,
    patterns: [read(`\\$\\{${NAME}`), define(`^\\s*-?\\s*${NAME}\\s*[:=]`)],
  },
  {
    // Covers `ENV A=1 B=2`, `export A=1`, `A=1 node app.js`, and `$A` / `${A}` references.
    kind: "shell",
    file: /(^|\/)Dockerfile[\w.-]*$|\.sh$/,
    patterns: [
      define(`^\\s*(?:ENV|ARG|export)\\s+${NAME}`),
      define(`(?:^|\\s)${NAME}=`),
      read(`\\$\\{?${NAME}`),
    ],
  },
  {
    kind: "code",
    file: /\.[cm]?[jt]sx?$|\.py$/,
    patterns: [
      read(`(?:process|Bun|import\\.meta)\\.env\\.${NAME}`),
      read(`(?:process|Bun|import\\.meta)\\.env\\[${QUOTED}\\]`),
      read(`os\\.environ(?:\\.get\\(|\\[)${QUOTED}`),
      read(`os\\.getenv\\(${QUOTED}`),
    ],
  },
];

/** Tracked files plus untracked files that .gitignore does not exclude. */
export function listFiles(dir) {
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

// lstat, not stat: a tracked `.env.example` symlink to a real `.env` must not be read.
function readSmallFile(path) {
  if (!existsSync(path)) return "";

  const stats = lstatSync(path);

  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return "";

  return readFileSync(path, "utf8");
}

function referencesIn(file, text, source) {
  return source.patterns.flatMap(({ role, regex }) =>
    [...text.matchAll(regex)].map((match) => ({
      file,
      line: lineOf(text, match.index),
      name: match[1],
      kind: source.kind,
      role,
    })),
  );
}

/** Every env-var name found in the project's example, compose, shell, and code files. */
export function scanReferences(dir, files) {
  return files.flatMap((file) => {
    const source = SOURCES.find((candidate) => candidate.file.test(file));

    return source === undefined
      ? []
      : referencesIn(file, readSmallFile(join(dir, file)), source);
  });
}
