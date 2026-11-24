import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const MAX_RECORD_BYTES = 16384;

function exactFields(value, required, optional = []) {
  if (value?.constructor !== Object) throw new Error("expected an object");

  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`missing field: ${key}`);

  const allowed = new Set([...required, ...optional]);

  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`unexpected field: ${key}`);
}

function boundedString(value, name, limit) {
  if (value?.constructor !== String)
    throw new Error(`${name} must be a string`);

  if (value.trim() === "") throw new Error(`${name} must not be blank`);

  if (Buffer.byteLength(value, "utf8") > limit)
    throw new Error(`${name} exceeds ${limit} UTF-8 bytes`);
}

function formattedString(value, name, format, limit) {
  boundedString(value, name, limit);

  if (!format.test(value)) throw new Error(`invalid ${name}`);
}

function validateTimestamp(value) {
  boundedString(value, "createdAt", 64);

  const date = new Date(value);

  if (!Number.isFinite(date.getTime()))
    throw new Error("invalid createdAt date");

  if (date.toISOString() !== value)
    throw new Error("createdAt must be an exact UTC ISO timestamp");
}

function validatePath(path) {
  boundedString(path, "path", 1024);

  if (/^[a-z]:/i.test(path))
    throw new Error("path must not have a drive prefix");

  if (/[\\\p{Cc}]/u.test(path))
    throw new Error("path must not contain backslashes or controls");

  if (path.split("/").some((part) => ["", ".", ".."].includes(part)))
    throw new Error("path must be relative with no empty, . or .. components");
}

function reviewText(value, name, limit) {
  boundedString(value, name, limit);

  if (/\[\s*decision\s*\]/iu.test(value))
    throw new Error("decision-tagged text cannot be imported");
}

function validateFinding(finding) {
  exactFields(
    finding,
    ["section", "path", "line", "text", "severity"],
    ["prescription"],
  );

  if (!["findings", "slop"].includes(finding.section))
    throw new Error("section must be findings or slop");

  if (!["blocker", "major", "minor"].includes(finding.severity))
    throw new Error("invalid finding severity");

  validatePath(finding.path);

  if (!Number.isSafeInteger(finding.line) || finding.line < 1)
    throw new Error("line must be a positive safe integer");

  reviewText(finding.text, "text", 8192);

  if (finding.prescription !== undefined)
    reviewText(finding.prescription, "prescription", 4096);
}

function validateProvenance(provenance) {
  exactFields(provenance, [
    "repoKey",
    "reviewedHead",
    "diffSha256",
    "verification",
  ]);
  formattedString(provenance.repoKey, "repoKey", SHA256, 64);
  formattedString(provenance.reviewedHead, "reviewedHead", OBJECT_ID, 64);
  formattedString(provenance.diffSha256, "diffSha256", SHA256, 64);

  if (provenance.verification !== "model-verified")
    throw new Error("verification must be model-verified");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Validate and return a normalized capture with deterministic field order. */
export function validateCapture(record) {
  exactFields(record, [
    "captureVersion",
    "id",
    "createdAt",
    "source",
    "finding",
    "provenance",
  ]);

  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_BYTES)
    throw new Error("capture exceeds 16384 serialized bytes");

  if (record.captureVersion !== 1)
    throw new Error("unsupported captureVersion");

  if (record.source !== "pr_review")
    throw new Error("source must be pr_review");

  formattedString(record.id, "id", SHA256, 64);
  validateTimestamp(record.createdAt);
  validateFinding(record.finding);
  validateProvenance(record.provenance);

  const { section, path, line, severity, prescription } = record.finding;
  const { repoKey, reviewedHead, diffSha256, verification } = record.provenance;

  const text = record.finding.text
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ");

  boundedString(text, "normalized text", 8192);

  const id = sha256(
    JSON.stringify([
      1,
      repoKey,
      reviewedHead,
      diffSha256,
      section,
      path,
      line,
      text,
    ]),
  );

  if (record.id !== id)
    throw new Error("capture id does not match its contents");

  const finding = { section, path, line, text, severity };

  if (prescription !== undefined) finding.prescription = prescription;

  return {
    captureVersion: 1,
    id,
    createdAt: record.createdAt,
    source: "pr_review",
    finding,
    provenance: { repoKey, reviewedHead, diffSha256, verification },
  };
}

function capturePayload(record) {
  return JSON.stringify([record.finding, record.provenance]);
}

/** Read the entire explicit source before returning any selected capture. */
export function readCaptures(path) {
  if (!isAbsolute(path)) throw new Error("--from must be an absolute path");

  if (!statSync(path).isFile())
    throw new Error("--from must be a regular file");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(path),
  );

  const captures = new Map();

  for (const line of text.split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES)
      throw new Error("capture exceeds 16384 serialized bytes");

    if (line.trim() === "") continue;

    const record = validateCapture(JSON.parse(line));
    const previous = captures.get(record.id);

    if (
      previous !== undefined &&
      capturePayload(previous) !== capturePayload(record)
    )
      throw new Error(`conflicting captures for id ${record.id}`);

    if (previous === undefined) captures.set(record.id, record);
  }

  return [...captures.values()];
}

/** Identify this clone/worktree without inherited Git routing or config. */
export function repositoryKey(cwd) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );

  const git = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    {
      cwd,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16384,
    },
  );

  if (git.status !== 0) throw new Error("cannot determine repository identity");

  const paths = git.stdout.trimEnd().split("\n");

  if (paths.length !== 2) throw new Error("invalid Git repository paths");

  const [top, common] = paths.map((path) => realpathSync(path));

  if (realpathSync(cwd) !== top)
    throw new Error("import and activate require the repository top level");

  return sha256(common);
}
