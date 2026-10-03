import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkEnv, suggest } from "../check.mjs";

test("suggest maps banned names and keeps role prefixes", () => {
  assert.equal(suggest("PROXY"), "PROXY_URL");
  assert.equal(suggest("DB_URL"), "DATABASE_URL");
  assert.equal(suggest("CATALOG_DB_URL"), "CATALOG_DATABASE_URL");
  assert.equal(suggest("COMLINK_DB_SCHEMA"), "COMLINK_DATABASE_SCHEMA");
  assert.equal(suggest("CACHE_REDIS_HOST"), "CACHE_REDIS_URL");
});

test("suggest accepts canonical, role-prefixed, and standard names", () => {
  for (const name of [
    "PROXY_URL",
    "PROXY_URLS",
    "VOYAGER_PROXY_URL",
    "DATABASE_URL",
    "CATALOG_IMPORTER_DATABASE_URL",
    "REDIS_URL",
    "HTTPS_PROXY",
    "NO_PROXY",
    "PROXY_REFRESH_DELAY",
  ]) {
    assert.equal(suggest(name), undefined, name);
  }
});

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "eden-lint-env-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  return dir;
}

function found(dir, rule) {
  return checkEnv(dir)
    .filter((v) => v.rule === rule)
    .map((v) => `${v.file}:${v.line}:${v.name}`)
    .sort();
}

test("checkEnv reports banned names in env examples, compose files, and code", () => {
  const dir = project({
    ".env.example": "DATABASE_URL=\n# PROXY_SERVER=\n",
    "compose.yaml":
      "services:\n  app:\n    environment:\n      REDIS_HOST: $" +
      "{REDIS_HOST}\n",
    "config.ts": "export const url = process.env.DB_URL;\n",
    "config.py": "import os\nproxy = os.environ.get('PROXY')\n",
  });

  assert.deepEqual(found(dir, "naming"), [
    ".env.example:2:PROXY_SERVER",
    "compose.yaml:4:REDIS_HOST",
    "config.py:2:PROXY",
    "config.ts:1:DB_URL",
  ]);
});

test("checkEnv skips allowed names, ignored paths, and gitignored .env files", () => {
  const dir = project({
    ".gitignore": ".env\n",
    ".env.example": "DATABASE_HOST=\n",
    ".eden-lint.json": JSON.stringify({
      env: {
        allow: { DATABASE_HOST: "Strapi reads split settings" },
        ignorePaths: ["fixture"],
      },
    }),
    "fixture.ts": "export const url = process.env.DB_URL;\n",
    ".env": "DB_URL=postgres://secret\n",
    "config.ts": "export const host = process.env.DATABASE_HOST;\n",
  });

  assert.deepEqual(checkEnv(dir), []);
});

test("checkEnv matches bracket, whitespace, and shell assignment forms", () => {
  const dir = project({
    "a.ts":
      'const a = Bun.env["DB_URL"];\nconst b = import.meta.env[ "PROXY" ];\nconst c = process.env.DB_URLS;\n',
    "b.py": 'import os\nos.getenv( "REDIS_HOST" )\n',
    Dockerfile: "ENV DATABASE_URL=x PROXY_SERVER=y\n",
    "run.sh": "DB_URL=x node app.js\n",
  });

  assert.deepEqual(found(dir, "naming"), [
    "Dockerfile:1:PROXY_SERVER",
    "a.ts:1:DB_URL",
    "a.ts:2:PROXY",
    "b.py:2:REDIS_HOST",
    "run.sh:1:DB_URL",
  ]);
});

test("checkEnv does not follow an example-file symlink", () => {
  const dir = project({
    ".gitignore": ".env\n",
    ".env": "DB_URL=postgres://secret\n",
  });

  symlinkSync(".env", join(dir, ".env.example"));

  assert.deepEqual(checkEnv(dir), []);
});

test("checkEnv reports real env files that git tracks or does not ignore", () => {
  const dir = project({
    ".gitignore": ".env\n",
    ".env": "A=1\n",
    ".env.production": "A=1\n",
    ".env.local": "A=1\n",
    ".env.example": "A=\n",
    "app/.env": "A=1\n",
  });

  execFileSync("git", ["add", "-f", "app/.env"], { cwd: dir });

  assert.deepEqual(found(dir, "env-file"), [
    ".env.local:1:",
    ".env.production:1:",
    "app/.env:1:",
  ]);
});

test("checkEnv reports reads missing from .env.example once per name", () => {
  const dir = project({
    ".env.example": "DATABASE_URL=\n# OPTIONAL_FLAG=\n",
    "a.ts":
      "process.env.DATABASE_URL;\nprocess.env.OPTIONAL_FLAG;\nprocess.env.API_KEY;\nprocess.env.NODE_ENV;\n",
    "b.ts": "process.env.API_KEY;\nprocess.env.GITHUB_SHA;\n",
    "compose.yaml":
      "services:\n  app:\n    environment:\n      WORKERS: $" +
      "{WORKERS:-2}\n",
  });

  assert.deepEqual(found(dir, "example"), [
    "a.ts:3:API_KEY",
    "compose.yaml:4:WORKERS",
  ]);
});

test("checkEnv reports a missing .env.example once when code reads env vars", () => {
  const dir = project({
    "a.ts": "process.env.API_KEY;\nprocess.env.SECRET_KEY;\n",
  });

  const violations = checkEnv(dir);

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /2 env var\(s\): API_KEY, SECRET_KEY/);
});
