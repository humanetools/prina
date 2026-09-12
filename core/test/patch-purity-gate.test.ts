/**
 * T8.4 patch purity gate test — stacks tags in a scratch git repo and
 * verifies pass/fail of scripts/patch-purity-gate.sh (§3.6).
 * No DB needed — pure git + bash + node.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateScript = path.join(coreRoot, "scripts", "patch-purity-gate.sh");
const extractorScript = path.join(coreRoot, "scripts", "env-required-keys.mjs");

let repo: string;

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function git(...args: string[]) {
  return sh("git", args);
}

function commitAll(message: string) {
  git("add", "-A");
  git("commit", "-m", message, "--no-verify");
}

/** Run the gate — returns exit code and output (stdout+stderr) */
function runGate(tag: string) {
  const r = spawnSync("bash", [gateScript, tag], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const ENV_TS_BASE = `import { z } from "zod";
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** e.g. postgres://user:pass@host:5432/prina */
  DATABASE_URL: z.string().url({ message: "DATABASE_URL is required (postgres://...)" }),
  ADMIN_DIST_PATH: z.string().optional(),
});
`;

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "prina-gate-"));
  git("init", "-q");
  git("config", "user.email", "gate-test@prina.dev");
  git("config", "user.name", "gate-test");

  mkdirSync(path.join(repo, "drizzle"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "drizzle", "0000_init.sql"), "CREATE TABLE t (id int);\n");
  writeFileSync(path.join(repo, "docker-compose.yml"), "services: {}\n");
  writeFileSync(path.join(repo, ".env.example"), "DATABASE_URL=\n");
  writeFileSync(path.join(repo, "src", "env.ts"), ENV_TS_BASE);
  writeFileSync(path.join(repo, "app.ts"), "export const version = 1;\n");
  commitAll("v0.1.0 baseline");
  git("tag", "v0.1.0");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("patch purity gate (T8.4)", () => {
  it("patch with code-only changes passes", () => {
    writeFileSync(path.join(repo, "app.ts"), "export const version = 2;\n");
    commitAll("fix: code-only change");
    git("tag", "v0.1.1");
    const { code, out } = runGate("v0.1.1");
    expect(code, out).toBe(0);
    expect(out).toContain("passed");
  });

  it("additive migrations pass (2026-08-21 rule: safe on the auto-update channel)", () => {
    writeFileSync(
      path.join(repo, "drizzle", "0001_additive.sql"),
      `ALTER TABLE "t" ADD COLUMN "seo" jsonb;--> statement-breakpoint\n` +
        `ALTER TABLE "t" ADD COLUMN "n" integer NOT NULL DEFAULT 0;--> statement-breakpoint\n` +
        `CREATE TABLE "t2" ("id" integer NOT NULL);--> statement-breakpoint\n` +
        `CREATE UNIQUE INDEX "t2_id_uq" ON "t2" ("id");\n`,
    );
    commitAll("feat: additive migration");
    git("tag", "v0.1.2");
    const { code, out } = runGate("v0.1.2");
    expect(code, out).toBe(0);
    expect(out).toContain("passed");
  });

  it("non-additive migration statements fail (DROP COLUMN)", () => {
    writeFileSync(
      path.join(repo, "drizzle", "0002_destructive.sql"),
      `ALTER TABLE "t" DROP COLUMN "seo";\n`,
    );
    commitAll("feat: destructive migration");
    git("tag", "v0.1.3");
    const { code, out } = runGate("v0.1.3");
    expect(code, out).toBe(1);
    expect(out).toContain("non-additive statement");
  });

  it("ADD COLUMN NOT NULL without DEFAULT fails (breaks existing rows)", () => {
    writeFileSync(
      path.join(repo, "drizzle", "0003_notnull.sql"),
      `ALTER TABLE "t" ADD COLUMN "must" text NOT NULL;\n`,
    );
    commitAll("feat: not-null without default");
    git("tag", "v0.1.4");
    const { code, out } = runGate("v0.1.4");
    expect(code, out).toBe(1);
    expect(out).toContain("NOT NULL column without a DEFAULT");
  });

  it("rewriting an existing migration file fails", () => {
    writeFileSync(path.join(repo, "drizzle", "0000_init.sql"), "CREATE TABLE t (id int, x int);\n");
    commitAll("chore: rewrite old migration");
    git("tag", "v0.1.5");
    const { code, out } = runGate("v0.1.5");
    expect(code, out).toBe(1);
    expect(out).toContain("rewrites or removes existing migrations");
  });

  it("patch containing compose changes fails", () => {
    writeFileSync(path.join(repo, "docker-compose.yml"), "services: { db: {} }\n");
    commitAll("chore: compose change");
    git("tag", "v0.1.6");
    const { code, out } = runGate("v0.1.6");
    expect(code, out).toBe(1);
    expect(out).toContain("contains compose/env template changes");
  });

  it("adding an optional env passes", () => {
    writeFileSync(
      path.join(repo, "src", "env.ts"),
      ENV_TS_BASE.replace(
        "});",
        `  BRAND_LOGO_URL: z.string().optional(),\n});`,
      ),
    );
    commitAll("feat: add optional env");
    git("tag", "v0.1.7");
    const { code, out } = runGate("v0.1.7");
    expect(code, out).toBe(0);
  });

  it("adding a new required env fails", () => {
    writeFileSync(
      path.join(repo, "src", "env.ts"),
      ENV_TS_BASE.replace(
        "});",
        `  BRAND_LOGO_URL: z.string().optional(),\n  LICENSE_SERVER_URL: z.string().url(),\n});`,
      ),
    );
    commitAll("feat: add required env");
    git("tag", "v0.1.8");
    const { code, out } = runGate("v0.1.8");
    expect(code, out).toBe(1);
    expect(out).toContain("contains new required env");
    expect(out).toContain("LICENSE_SERVER_URL");
  });

  it("adding an env with a default passes (not required)", () => {
    writeFileSync(
      path.join(repo, "src", "env.ts"),
      ENV_TS_BASE.replace(
        "});",
        `  BRAND_LOGO_URL: z.string().optional(),\n  LICENSE_SERVER_URL: z.string().url(),\n  LICENSE_GRACE_DAYS: z.coerce.number().default(14),\n});`,
      ),
    );
    commitAll("feat: add defaulted env");
    git("tag", "v0.1.9");
    // only LICENSE_GRACE_DAYS added vs the previous tag (v0.1.8) — has a default, so it passes
    const { code, out } = runGate("v0.1.9");
    expect(code, out).toBe(0);
  });

  it("minor/major releases are out of scope for the gate", () => {
    const { code, out } = runGate("v0.2.0");
    expect(code, out).toBe(0);
    expect(out).toContain("not applicable");
  });

  it("patch without a previous tag fails", () => {
    git("tag", "v0.3.5");
    const { code, out } = runGate("v0.3.5");
    expect(code, out).toBe(1);
    expect(out).toContain("previous tag (v0.3.4) not found");
  });

  it("tags not in vX.Y.Z form pass as out of scope", () => {
    const { code, out } = runGate("nightly-build");
    expect(code, out).toBe(0);
    expect(out).toContain("not applicable");
  });
});

describe("env-required-keys extractor", () => {
  it("the real src/env.ts has exactly one required key: DATABASE_URL", () => {
    const r = spawnSync("node", [extractorScript, path.join(coreRoot, "src", "env.ts")], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(["DATABASE_URL"]);
  });

  it("is not fooled by parens/braces inside strings", () => {
    const tricky = path.join(repo, "tricky-env.ts");
    writeFileSync(
      tricky,
      `import { z } from "zod";
const envSchema = z.object({
  // Parens and braces } ) inside comments are ignored too
  A_URL: z.string().url({ message: "parens (nested) and a brace } included" }),
  B_OPT: z.string().optional(), // comment after .optional(
  C_DEF: z.enum(["x", "y"]).default("x"),
});
`,
    );
    const r = spawnSync("node", [extractorScript, tricky], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(["A_URL"]);
  });
});
