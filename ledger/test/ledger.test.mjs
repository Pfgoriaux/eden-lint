import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  closeEntry,
  globToRegex,
  matchPattern,
  parseLedger,
  promoteEntry,
  runLedger,
  validateEntry,
} from "../ledger.mjs";

const valid = { text: "Prefer guard clauses", tag: "style", severity: "minor" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "antislop-"));
}

function ledgerLines(cwd) {
  return readFileSync(join(cwd, ".antislop.jsonl"), "utf8").trim().split("\n");
}

test("validateEntry accepts a valid entry", () => {
  assert.equal(validateEntry(valid), null);
  assert.equal(validateEntry({ ...valid, pattern: "spawn\\(" }), null);
  assert.equal(validateEntry({ ...valid, state: "open" }), null);
});

test("validateEntry refuses unknown tags, severities, states, patterns, and globs", () => {
  assert.match(validateEntry({ ...valid, tag: "vibe" }), /unknown tag/);
  assert.match(validateEntry({ ...valid, tag: undefined }), /unknown tag/);
  assert.match(
    validateEntry({ ...valid, severity: "huge" }),
    /unknown severity/,
  );
  assert.match(validateEntry({ ...valid, state: "done" }), /unknown state/);
  assert.match(validateEntry({ ...valid, pattern: "(" }), /does not compile/);
  assert.match(
    validateEntry({ ...valid, glob: "[abc" }),
    /glob does not compile/,
  );
  assert.match(validateEntry({ ...valid, text: "" }), /text must be/);
});

test("globToRegex translates braces, negated classes, and **/", () => {
  const glob = globToRegex("**/*.{ts,tsx}");

  assert.equal(glob.test("a/b.ts"), true);
  assert.equal(glob.test("b.tsx"), true);
  assert.equal(glob.test("b.js"), false);
  assert.equal(globToRegex("[!a]bc").test("xbc"), true);
  assert.equal(globToRegex("[!a]bc").test("abc"), false);
  assert.equal(globToRegex("**/index.ts").test("src/index.ts"), true);
  assert.equal(globToRegex("**/index.ts").test("index.ts"), true);
  assert.equal(globToRegex("**/index.ts").test("myindex.ts"), false);
});

test("globToRegex throws on unclosed braces and brackets instead of looping", () => {
  assert.throws(() => globToRegex("**/{a.ts"), /unclosed \{/);
  assert.throws(() => globToRegex("**/[a.ts"), /unclosed \[/);
});

test("runLedger add refuses a glob that does not translate", () => {
  const cwd = tempDir();

  assert.equal(
    runLedger(["add", "--text=t", "--tag=style", "--glob", "[unclosed"], {
      cwd,
    }),
    1,
  );
});

test("runLedger add refuses invalid tags, severities, and patterns", () => {
  const cwd = tempDir();

  assert.equal(runLedger(["add", "--text", "t", "--tag", "vibe"], { cwd }), 1);
  assert.equal(
    runLedger(["add", "--text", "t", "--tag", "style", "--severity", "huge"], {
      cwd,
    }),
    1,
  );
  assert.equal(
    runLedger(["add", "--text", "t", "--tag", "style", "--pattern", "("], {
      cwd,
    }),
    1,
  );
  assert.equal(runLedger(["add", "--tag", "style"], { cwd }), 2);
});

test("runLedger add appends a valid entry with a generated id", () => {
  const cwd = tempDir();

  const code = runLedger(
    [
      "add",
      "--text",
      "Do not spawn a shell for a fixed argv",
      "--tag",
      "safety",
      "--severity",
      "major",
      "--pattern",
      "shell:\\s*true",
      "--glob",
      "**/*.mjs",
      "--source",
      "review",
    ],
    { cwd },
  );

  assert.equal(code, 0);

  const entry = JSON.parse(ledgerLines(cwd)[0]);

  assert.match(entry.id, /^\d+-[0-9a-f]{4}$/);
  assert.equal(entry.state, "open");
  assert.equal(entry.tag, "safety");
  assert.equal(entry.severity, "major");
  assert.equal(entry.pattern, "shell:\\s*true");
  assert.equal(entry.glob, "**/*.mjs");
  assert.equal(entry.source, "review");
  assert.notEqual(entry.createdAt, undefined);
});

test("runLedger accepts --name=value flags", () => {
  const cwd = tempDir();

  const code = runLedger(
    ["add", "--text=t", "--tag=style", "--severity=minor"],
    { cwd },
  );

  assert.equal(code, 0);
  assert.equal(JSON.parse(ledgerLines(cwd)[0]).tag, "style");
});

test("runLedger list filters by state and tag and prints the matching entries", () => {
  const cwd = tempDir();

  runLedger(["add", "--text=t", "--tag=style"], { cwd });
  runLedger(["add", "--text=t2", "--tag=safety"], { cwd });

  const log = mock.method(console, "log");

  try {
    assert.equal(
      runLedger(["list", "--state", "open", "--tag", "safety"], { cwd }),
      0,
    );
    assert.equal(runLedger(["list", "--state", "closed"], { cwd }), 0);
  } finally {
    log.mock.restore();
  }

  const lines = log.mock.calls.map((call) => call.arguments[0]);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /open\s+safety/);
  assert.match(lines[0], /t2/);
});

test("promote and close append; parseLedger keeps the latest state per id", () => {
  const cwd = tempDir();

  runLedger(["add", "--text", "No shell spawn", "--tag", "safety"], { cwd });

  const id = parseLedger(ledgerLines(cwd).join("\n"))[0].id;

  assert.equal(
    runLedger(["promote", "--id", id, "--to", "biome/plugins/no-shell.grit"], {
      cwd,
    }),
    0,
  );
  assert.equal(
    runLedger(["close", "--id", id, "--reason", "superseded"], { cwd }),
    0,
  );

  const lines = ledgerLines(cwd);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).state, "open");

  const latest = parseLedger(lines.join("\n"));
  assert.equal(latest.length, 1);
  assert.equal(latest[0].state, "closed");
  assert.equal(latest[0].reason, "superseded");

  const promoted = JSON.parse(lines[1]);
  assert.equal(promoted.state, "promoted");
  assert.equal(promoted.promotedTo, "biome/plugins/no-shell.grit");
});

test("runLedger promote and close refuse unknown ids and missing flags", () => {
  const cwd = tempDir();

  runLedger(["add", "--text=t", "--tag=style"], { cwd });

  assert.equal(
    runLedger(["promote", "--id", "nope", "--to", "rule"], { cwd }),
    1,
  );
  assert.equal(runLedger(["close", "--id", "nope"], { cwd }), 1);
  assert.equal(runLedger(["promote", "--to", "rule"], { cwd }), 2);
  assert.equal(runLedger(["close"], { cwd }), 2);
});

test("promoteEntry and closeEntry return copies with the new state", () => {
  const entry = { id: "1-abcd", ...valid, state: "open" };

  assert.deepEqual(promoteEntry(entry, "lint/style/x"), {
    id: "1-abcd",
    text: "Prefer guard clauses",
    tag: "style",
    severity: "minor",
    state: "promoted",
    promotedTo: "lint/style/x",
  });
  assert.deepEqual(closeEntry(entry, "done"), {
    id: "1-abcd",
    text: "Prefer guard clauses",
    tag: "style",
    severity: "minor",
    state: "closed",
    reason: "done",
  });
  assert.equal(closeEntry(entry).reason, undefined);
  assert.equal(entry.state, "open");
});

test("matchPattern is case-insensitive by default", () => {
  const entry = { pattern: "TODO" };
  const files = [{ path: "a.ts", text: "fix this todo\nnothing here" }];

  assert.deepEqual(matchPattern(entry, files), [{ path: "a.ts", line: 1 }]);
});

test("matchPattern honors (?-i) for case-sensitive matching", () => {
  const entry = { pattern: "(?-i)TODO" };
  const files = [{ path: "a.ts", text: "todo\nTODO" }];

  assert.deepEqual(matchPattern(entry, files), [{ path: "a.ts", line: 2 }]);
});

test("matchPattern filters files by the entry glob", () => {
  const entry = { pattern: "x", glob: "**/*.py" };

  const files = [
    { path: "src/a.ts", text: "x" },
    { path: "scripts/b.py", text: "x" },
  ];

  assert.deepEqual(matchPattern(entry, files), [
    { path: "scripts/b.py", line: 1 },
  ]);
});

test("matchPattern defaults to code files at any depth", () => {
  const entry = { pattern: "x" };

  const files = [
    { path: "a.ts", text: "x" },
    { path: "a.md", text: "x" },
    { path: "deep/dir/a.mjs", text: "x" },
  ];

  assert.deepEqual(matchPattern(entry, files), [
    { path: "a.ts", line: 1 },
    { path: "deep/dir/a.mjs", line: 1 },
  ]);
});

test("runLedger check exits 0 with no matches and counts unenforced entries", () => {
  const cwd = tempDir();

  runLedger(["add", "--text=t", "--tag=style", "--pattern", "NEVERSEEN"], {
    cwd,
  });
  runLedger(["add", "--text=t2", "--tag=docs"], { cwd });

  assert.equal(runLedger(["check"], { cwd }), 0);
});

test("runLedger check exits 1 when a pattern matches a file", () => {
  const cwd = tempDir();

  writeFileSync(join(cwd, "probe.ts"), "const shell = { shell: true };\n");

  runLedger(
    ["add", "--text=t", "--tag=safety", "--pattern", "shell:\\s*true"],
    { cwd },
  );

  assert.equal(runLedger(["check"], { cwd }), 1);
});

function writeLedger(cwd, lines) {
  writeFileSync(join(cwd, ".antislop.jsonl"), `${lines.join("\n")}\n`);
}

function validLine(overrides) {
  return JSON.stringify({ id: "1-abcd", ...valid, ...overrides });
}

test("every subcommand exits 1 on a malformed JSON line", () => {
  const cwd = tempDir();

  writeLedger(cwd, ["{not json"]);

  assert.equal(runLedger(["list"], { cwd }), 1);
  assert.equal(runLedger(["check"], { cwd }), 1);
  assert.equal(runLedger(["close", "--id", "1-abcd"], { cwd }), 1);
});

test("every subcommand exits 1 on an entry without an id", () => {
  const cwd = tempDir();

  writeLedger(cwd, [JSON.stringify({ ...valid, state: "open" })]);

  assert.equal(runLedger(["list"], { cwd }), 1);
  assert.equal(runLedger(["check"], { cwd }), 1);
  assert.equal(
    runLedger(["promote", "--id", "1-abcd", "--to", "r"], { cwd }),
    1,
  );
});

test("every subcommand exits 1 on an invalid entry on disk", () => {
  const cwd = tempDir();

  writeLedger(cwd, [validLine({ pattern: "(" })]);

  assert.equal(runLedger(["list"], { cwd }), 1);
  assert.equal(runLedger(["check"], { cwd }), 1);
  assert.equal(runLedger(["close", "--id", "1-abcd"], { cwd }), 1);
});

test("a valid line still loads when another line is invalid", () => {
  const cwd = tempDir();

  writeLedger(cwd, ["{not json", validLine()]);

  assert.equal(runLedger(["list"], { cwd }), 1);
});

test("runLedger check skips files behind symlinks", () => {
  const cwd = tempDir();
  const outside = tempDir();

  writeFileSync(join(outside, "real.ts"), "const shell = { shell: true };\n");
  symlinkSync(join(outside, "real.ts"), join(cwd, "link.ts"));

  runLedger(
    ["add", "--text=t", "--tag=safety", "--pattern", "shell:\\s*true"],
    { cwd },
  );

  assert.equal(runLedger(["check"], { cwd }), 0);
});
