import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEntry } from "../ledger.mjs";

const cli = fileURLToPath(new URL("../../bin/eden-lint.mjs", import.meta.url));

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "ledger-capture-")));

const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

console.log(`Retained capture fixtures: ${fixtures}`);

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16384,
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identify(record) {
  const { provenance, finding } = record;

  record.id = digest(
    JSON.stringify([
      1,
      provenance.repoKey,
      provenance.reviewedHead,
      provenance.diffSha256,
      finding.section,
      finding.path,
      finding.line,
      finding.text.normalize("NFC").trim().replace(/\s+/gu, " "),
    ]),
  );

  return record;
}

function fixture() {
  const cwd = mkdtempSync(join(fixtures, "repo-"));

  git(cwd, ["init", "-q"]);

  const common = realpathSync(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );

  const record = identify({
    captureVersion: 1,
    id: "",
    createdAt: "2026-02-28T12:34:56.123Z",
    source: "pr_review",
    finding: {
      section: "findings",
      path: "probe.ts",
      line: 1,
      text: "  Avoid\tcafe\u0301  shell calls.\n",
      severity: "blocker",
      prescription: "Pass an argv array.",
    },
    provenance: {
      repoKey: digest(common),
      reviewedHead: "a".repeat(40),
      diffSha256: "b".repeat(64),
      verification: "model-verified",
    },
  });

  const from = join(mkdtempSync(join(fixtures, "external-")), "captures.jsonl");
  const ledger = join(cwd, ".antislop.jsonl");

  writeFileSync(from, `${JSON.stringify(record)}\n`);
  writeFileSync(join(cwd, "probe.ts"), "shell: true\n");

  return { cwd, record, from, ledger };
}

function run(cwd, args, overrides = {}) {
  const result = spawnSync(process.execPath, [cli, "ledger", ...args], {
    cwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);

  return result;
}

function succeeds(cwd, args, overrides) {
  const result = run(cwd, args, overrides);

  assert.equal(result.status, 0, result.stderr);

  return result.stdout;
}

function importArgs(f) {
  return ["import", "--from", f.from, "--id", f.record.id];
}

function activationArgs(f) {
  return [
    "activate",
    "--id",
    f.record.id,
    "--pattern",
    "shell:\\s*true",
    "--glob",
    "**/*.ts",
  ];
}

function entries(f) {
  return readFileSync(f.ledger, "utf8").trim().split("\n").map(JSON.parse);
}

function refreshChangedId(record, name) {
  if (name === "id") return;

  if (record.finding?.text?.constructor !== String) return;

  if (record.provenance === null) return;

  identify(record);
}

function snapshot(cwd) {
  return readdirSync(cwd, { withFileTypes: true }).flatMap((entry) => {
    const path = join(cwd, entry.name);

    if (entry.isDirectory()) return [[path, "directory"], ...snapshot(path)];

    return [[path, readFileSync(path).toString("hex")]];
  });
}

test("external listing is read-only, deduplicated, and independent of cwd identity", () => {
  const f = fixture();
  const other = fixture();
  const equivalent = structuredClone(f.record);

  equivalent.finding.text = "Avoid café shell calls.";
  writeFileSync(
    f.from,
    `${JSON.stringify(f.record)}\n${JSON.stringify(equivalent)}\n`,
  );

  const before = snapshot(fixtures);
  const output = succeeds(other.cwd, ["list", "--from", f.from]);

  assert.equal(output.trim().split("\n").length, 1);
  assert.match(output, new RegExp(f.record.id));
  assert.match(output, /Avoid café shell calls/);
  succeeds(fixtures, ["list", "--from", f.from]);
  assert.deepEqual(snapshot(fixtures), before);
});

test("duplicate captures with different timestamps retain the first timestamp", () => {
  const f = fixture();
  const duplicate = { ...f.record, createdAt: "2026-02-27T12:34:56.123Z" };

  writeFileSync(
    f.from,
    `${JSON.stringify(f.record)}\n${JSON.stringify(duplicate)}\n`,
  );

  const listed = succeeds(f.cwd, ["list", "--from", f.from]);

  assert.equal(listed.trim().split("\n").length, 1);
  succeeds(f.cwd, importArgs(f));
  assert.equal(entries(f).length, 1);
  assert.equal(entries(f)[0].createdAt, f.record.createdAt);
});

test("listing and matches escape terminal controls without changing captured text", () => {
  const f = fixture();

  f.record.finding.text = "Unsafe \u001b[2J shell call.";
  identify(f.record);
  writeFileSync(f.from, `${JSON.stringify(f.record)}\n`);

  const external = succeeds(f.cwd, ["list", "--from", f.from]);

  assert.equal(external.includes("\u001b"), false);
  assert.match(external, /\\u001b\[2J/);
  succeeds(f.cwd, importArgs(f));
  assert.equal(entries(f)[0].text, f.record.finding.text);

  const local = succeeds(f.cwd, ["list"]);

  assert.equal(local.includes("\u001b"), false);
  assert.match(local, /\\u001b\[2J/);
  succeeds(f.cwd, activationArgs(f));

  const checked = run(f.cwd, ["check"]);

  assert.equal(checked.status, 1);
  assert.equal(checked.stdout.includes("\u001b"), false);
  assert.match(checked.stdout, /\\u001b\[2J/);

  f.record["\u001b[2J"] = "unexpected";
  writeFileSync(f.from, `${JSON.stringify(f.record)}\n`);

  const rejected = run(f.cwd, ["list", "--from", f.from]);

  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes("\u001b"), false);
  assert.match(rejected.stderr, /\\u001b\[2J/);
});

test("import is unenforced; activation enforces; reimport preserves the active entry", () => {
  const f = fixture();

  succeeds(f.cwd, importArgs(f));

  const [entry] = entries(f);

  assert.deepEqual(entry, {
    id: f.record.id,
    text: "Avoid café shell calls.",
    tag: "safety",
    severity: "major",
    state: "open",
    createdAt: f.record.createdAt,
    prescription: f.record.finding.prescription,
    source: "pr_review",
    captureVersion: 1,
    provenance: {
      ...f.record.provenance,
      section: "findings",
      path: "probe.ts",
      line: 1,
    },
  });
  assert.match(succeeds(f.cwd, ["check"]), /1 open entries without a pattern/);
  succeeds(f.cwd, activationArgs(f));
  assert.equal(entries(f).length, 2);
  assert.deepEqual(entries(f)[1].provenance, entry.provenance);
  assert.equal(run(f.cwd, ["check"]).status, 1);

  const before = readFileSync(f.ledger);

  succeeds(f.cwd, importArgs(f));
  assert.deepEqual(readFileSync(f.ledger), before);
  assert.equal(run(f.cwd, ["check"]).status, 1);
  writeFileSync(join(f.cwd, "probe.ts"), "shell: false\n");
  assert.equal(run(f.cwd, ["check"]).status, 0);
});

for (const state of ["closed", "promoted"]) {
  test(`reimport and activation cannot reopen a ${state} entry`, () => {
    const f = fixture();

    succeeds(f.cwd, importArgs(f));
    succeeds(f.cwd, activationArgs(f));
    succeeds(
      f.cwd,
      state === "closed"
        ? ["close", "--id", f.record.id, "--reason", "done"]
        : ["promote", "--id", f.record.id, "--to", "lint/no-shell"],
    );

    const before = readFileSync(f.ledger);

    succeeds(f.cwd, importArgs(f));
    assert.equal(run(f.cwd, activationArgs(f)).status, 1);
    assert.deepEqual(readFileSync(f.ledger), before);
    assert.equal(entries(f).at(-1).state, state);
    assert.equal(run(f.cwd, ["check"]).status, 0);
  });
}

test("only the selected ID is imported; slop maps to style and preserves severity", () => {
  const f = fixture();
  const slop = structuredClone(f.record);

  slop.finding = {
    section: "slop",
    path: "docs/guide.md",
    line: 2,
    text: "Remove filler.",
    severity: "minor",
  };
  slop.createdAt = "2026-02-28T13:34:56.000Z";
  slop.provenance.reviewedHead = "c".repeat(64);
  identify(slop);
  writeFileSync(
    f.from,
    `${JSON.stringify(f.record)}\n${JSON.stringify(slop)}\n`,
  );
  succeeds(f.cwd, ["import", "--from", f.from, "--id", slop.id]);
  assert.equal(entries(f).length, 1);
  assert.equal(entries(f)[0].tag, "style");
  assert.equal(entries(f)[0].severity, "minor");
  assert.equal(entries(f)[0].prescription, undefined);
  assert.equal(entries(f)[0].createdAt, slop.createdAt);
});

test("canonical UTC ISO timestamps include valid leap days and extended years", () => {
  for (const createdAt of [
    "2024-02-29T12:34:56.789Z",
    "+010000-01-01T00:00:00.000Z",
  ]) {
    const f = fixture();

    f.record.createdAt = createdAt;
    writeFileSync(f.from, `${JSON.stringify(f.record)}\n`);
    succeeds(f.cwd, importArgs(f));
    assert.equal(entries(f)[0].createdAt, createdAt);
  }
});

const invalidCaptures = [
  ["captureVersion", 2],
  ["source", "other"],
  ["createdAt", "2026-02-30T00:00:00Z"],
  ["createdAt", "2026-02-30T00:00:00.000Z"],
  ["createdAt", "2026-02-28T13:34:56.000+01:00"],
  ["createdAt", "2026-02-28T13:34:56+01:00"],
  ["createdAt", "2026-02-28T13:34:56Z"],
  ["createdAt", "2026-02-28T13:34:56.0000Z"],
  ["createdAt", "2026-02-28T00:00:00Z\n"],
  ["createdAt", 1],
  ["createdAt", "yesterday"],
  ["id", "0".repeat(64)],
  ["provenance.diffSha256", "B".repeat(64)],
  ["provenance.repoKey", "short"],
  ["provenance.reviewedHead", "not-a-commit"],
  ["provenance.reviewedHead", `${"a".repeat(40)}\n`],
  ["provenance.verification", "unverified"],
  ["finding.section", "decisions"],
  ["finding.text", "[DeCiSiOn] Choose a policy."],
  ["finding.prescription", "[decision] Choose."],
  ["finding.severity", "critical"],
  ["finding.text", 2],
  ["finding.text", " \n\t "],
  ["finding.text", "é".repeat(4097)],
  ["finding.prescription", "é".repeat(2049)],
  ["finding.prescription", null],
  ["finding.prescription", ""],
  ["finding.prescription", " \t\n"],
  ["finding.path", "é".repeat(513)],
  ["finding.line", 0],
  ["finding.line", 1.5],
  ["finding.line", Number.MAX_SAFE_INTEGER + 1],
  ["finding.line", "1"],
  ["finding", { text: "missing" }],
  ["finding", null],
  ["provenance", null],
];

for (const path of [
  "/a",
  "C:/x",
  "c:x",
  "Z:",
  "a\\b",
  "a//b",
  "./a",
  "a/../b",
  "a/",
  "a\nb",
  "a\u007fb",
  " ",
  "",
]) {
  invalidCaptures.push(["finding.path", path]);
}

for (const field of ["pattern", "glob", "tag", "state", "unknown"]) {
  for (const prefix of ["", "finding.", "provenance."])
    invalidCaptures.push([`${prefix}${field}`, "injected"]);
}

function changeField(record, name, value) {
  const [parent, child] = name.split(".");

  if (child === undefined) record[parent] = value;
  else record[parent][child] = value;
}

test("invalid capture fields leave the destination byte-for-byte unchanged", () => {
  const f = fixture();

  succeeds(f.cwd, ["add", "--text", "Manual entry", "--tag", "docs"]);

  const before = readFileSync(f.ledger);

  for (const [name, value] of invalidCaptures) {
    const record = structuredClone(f.record);

    changeField(record, name, value);
    refreshChangedId(record, name);
    writeFileSync(f.from, `${JSON.stringify(record)}\n`);

    const result = run(f.cwd, ["import", "--from", f.from, "--id", record.id]);

    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /no capture with id|another clone/);
    assert.deepEqual(readFileSync(f.ledger), before, name);

    const listed = run(f.cwd, ["list", "--from", f.from]);

    assert.equal(listed.status, 1, `${name}: ${listed.stderr}`);
    assert.equal(listed.stdout, "");
    assert.deepEqual(readFileSync(f.ledger), before, name);
  }
});

test("malformed files and conflicting duplicate payloads fail before any append", () => {
  const f = fixture();
  const changed = structuredClone(f.record);
  const changedPrescription = structuredClone(f.record);

  changed.finding.severity = "minor";
  changedPrescription.finding.prescription = "A different prescription.";

  const first = JSON.stringify(f.record);

  const invalid = [
    "{bad",
    "null",
    "[]",
    `${first}\n{bad`,
    `${first}\n${JSON.stringify(changed)}`,
    `${first}\n${JSON.stringify(changedPrescription)}`,
    `${" ".repeat(16384)}${first}`,
    Buffer.from([0xff]),
  ];

  for (const value of invalid) {
    writeFileSync(f.from, value);
    assert.equal(run(f.cwd, importArgs(f)).status, 1);
    assert.equal(run(f.cwd, ["list", "--from", f.from]).status, 1);
    assert.equal(existsSync(f.ledger), false);
  }

  assert.equal(
    run(f.cwd, ["import", "--from", `${f.from}.missing`, "--id", f.record.id])
      .status,
    1,
  );
  assert.equal(
    run(f.cwd, ["import", "--from", "relative.jsonl", "--id", f.record.id])
      .status,
    1,
  );
  assert.equal(existsSync(f.ledger), false);
});

test("import and activation require the repository root; Git environment cannot redirect identity", () => {
  const f = fixture();
  const other = fixture();
  const nested = join(f.cwd, "nested");

  mkdirSync(nested);
  assert.equal(run(other.cwd, importArgs(f)).status, 1);
  assert.equal(run(nested, importArgs(f)).status, 1);
  assert.equal(run(fixtures, importArgs(f)).status, 1);
  assert.equal(existsSync(other.ledger), false);
  assert.equal(existsSync(join(nested, ".antislop.jsonl")), false);
  succeeds(f.cwd, importArgs(f), {
    GIT_DIR: join(other.cwd, ".git"),
    GIT_WORK_TREE: other.cwd,
    GIT_COMMON_DIR: join(other.cwd, ".git"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  });
  assert.equal(run(nested, activationArgs(f)).status, 1);
  assert.equal(existsSync(join(nested, ".antislop.jsonl")), false);
});

test("linked worktrees share identity but a clone does not", () => {
  const f = fixture();
  const worktree = join(fixtures, `worktree-${f.record.id}`);
  const clone = join(fixtures, `clone-${f.record.id}`);

  git(f.cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@local",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  git(f.cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--detach",
    worktree,
  ]);
  git(f.cwd, ["clone", "--no-local", f.cwd, clone]);
  succeeds(worktree, importArgs(f));
  assert.equal(run(clone, importArgs(f)).status, 1);
  assert.equal(existsSync(join(clone, ".antislop.jsonl")), false);
});

test("activation rejects missing approval, invalid regex/glob, and unknown IDs without writes", () => {
  const f = fixture();

  succeeds(f.cwd, importArgs(f));

  const before = readFileSync(f.ledger);

  const invalid = [
    ["activate", "--id", f.record.id],
    ["activate", "--id", "missing", "--pattern", "x", "--glob", "*.ts"],
    ["activate", "--id", f.record.id, "--pattern", "", "--glob", "*.ts"],
    ["activate", "--id", f.record.id, "--pattern", "x", "--glob", " \t"],
    ["activate", "--id", f.record.id, "--pattern", "(", "--glob", "*.ts"],
    ["activate", "--id", f.record.id, "--pattern", "x", "--glob", "[bad"],
  ];

  for (const args of invalid) {
    assert.notEqual(run(f.cwd, args).status, 0);
    assert.deepEqual(readFileSync(f.ledger), before);
  }

  for (const field of ["pattern", "glob"]) {
    for (const value of [1, {}, [], null]) {
      assert.notEqual(
        validateEntry({ ...entries(f)[0], [field]: value }),
        null,
      );
    }
  }
});

test("the complete destination is validated, including superseded history and capture metadata", () => {
  const f = fixture();

  succeeds(f.cwd, importArgs(f));

  const valid = readFileSync(f.ledger, "utf8");
  const brokenMetadata = { ...entries(f)[0], provenance: { repoKey: "bad" } };

  const invalidBytes = Buffer.from(
    '{"id":"legacy","text":"bad#","tag":"docs","severity":"minor","state":"open"}',
  );

  invalidBytes[invalidBytes.indexOf("#")] = 0xff;

  for (const invalid of [
    "{bad",
    "null",
    '{"id":"manual","text":"x","tag":"bad","severity":"minor"}',
    JSON.stringify(brokenMetadata),
    invalidBytes,
  ]) {
    writeFileSync(
      f.ledger,
      Buffer.concat([Buffer.from(invalid), Buffer.from(`\n${valid}`)]),
    );

    const before = readFileSync(f.ledger);

    assert.equal(run(f.cwd, importArgs(f)).status, 1);
    assert.equal(run(f.cwd, activationArgs(f)).status, 1);
    assert.deepEqual(readFileSync(f.ledger), before);
  }
});

test("symlinked destinations, including dangling links, are refused", () => {
  for (const dangling of [false, true]) {
    const f = fixture();
    const target = join(fixtures, `target-${f.record.id}`);

    if (!dangling) writeFileSync(target, "");

    symlinkSync(target, f.ledger);
    assert.equal(run(f.cwd, importArgs(f)).status, 1);
    assert.equal(run(f.cwd, activationArgs(f)).status, 1);
    assert.equal(existsSync(target), !dangling);

    if (!dangling) assert.equal(readFileSync(target, "utf8"), "");
  }
});

test("manual entries survive import; append separates a missing final newline", () => {
  const f = fixture();

  const manual = {
    id: "manual",
    text: "Keep manual metadata.",
    tag: "docs",
    severity: "minor",
    state: "open",
    source: "pr_review",
    extra: "retained",
  };

  const original = JSON.stringify(manual);

  writeFileSync(f.ledger, original);
  succeeds(f.cwd, importArgs(f));
  assert.deepEqual(entries(f)[0], manual);
  assert.ok(readFileSync(f.ledger, "utf8").startsWith(`${original}\n`));
  succeeds(f.cwd, [
    "activate",
    "--id",
    "manual",
    "--pattern",
    "(?-i)NEVER",
    "--glob",
    "*.ts",
  ]);
  assert.deepEqual(entries(f).at(-1), {
    ...manual,
    pattern: "(?-i)NEVER",
    glob: "*.ts",
  });
});
