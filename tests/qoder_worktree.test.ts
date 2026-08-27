import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReviewPatch,
  createReviewPatch,
  disposeWorktree,
  inspectWorktree,
  prepareWorktree,
  reopenReviewWorktree,
} from "@qoder-agent-bridge/core";
import { executeWorktreeCommand, parseWorktreeArgs } from "../packages/cli/src/qoder-worktree";
import { enforceIncludedArtifactLimits } from "../packages/core/src/worktree/included-artifacts";

const fixtures: string[] = [];
const worktreeRunnerPath = fileURLToPath(
  new URL("../dist/skills/qoder-agent/scripts/qoder_worktree.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "qoder-worktree-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Qoder Worktree Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

async function listSessionRoots() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("qoder-agent-worktree-"))
    .sort();
}

describe("Qoder isolated worktree coordinator", () => {
  it("validates its narrow lifecycle arguments", () => {
    expect(() => parseWorktreeArgs(["prepare", "--cwd", "relative"])).not.toThrow();
    expect(
      parseWorktreeArgs(["prepare", "--cwd", "relative", "--retry-of", "/tmp/session.json"]),
    ).toMatchObject({ retryOf: "/tmp/session.json" });
    expect(() => parseWorktreeArgs(["prepare", "--state", "/tmp/session.json"])).toThrow(
      /prepare requires/,
    );
    expect(() => parseWorktreeArgs(["diff", "--state", "/tmp/session.json", "--discard"])).toThrow(
      /diff requires/,
    );
    expect(() => parseWorktreeArgs(["inspect", "--state", "/tmp/session.json"])).not.toThrow();
    expect(() => parseWorktreeArgs(["reopen", "--state", "/tmp/session.json"])).not.toThrow();
    expect(() =>
      parseWorktreeArgs(["dispose", "--state", "/tmp/session.json", "--discard"]),
    ).not.toThrow();
    expect(() =>
      parseWorktreeArgs(["apply", "--state", "/tmp/session.json", "--retry-of", "/tmp/old.json"]),
    ).toThrow(/apply requires/);
  });

  it("reviews and applies only Qoder changes over a dirty source baseline", async () => {
    const root = await createFixture();
    await writeFile(join(root, "tracked.txt"), "user staged\n");
    git(root, ["add", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "user working\n");
    await writeFile(join(root, "untracked.txt"), "keep this baseline\n");

    const session = await prepareWorktree(root);
    expect(await readFile(join(session.worktreeRoot, "tracked.txt"), "utf8")).toBe(
      "user working\n",
    );
    expect(await readFile(join(session.worktreeRoot, "untracked.txt"), "utf8")).toBe(
      "keep this baseline\n",
    );
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user working\n");

    await writeFile(join(session.worktreeRoot, "tracked.txt"), "qoder result\n");
    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "new code\n");
    const inspection = await inspectWorktree(session.statePath);
    expect(inspection).toMatchObject({
      hasChanges: true,
      changedFiles: ["qoder-new.txt", "tracked.txt"],
      indexModified: false,
      session: { phase: "prepared" },
    });
    const review = await createReviewPatch(session.statePath);

    expect(review.changedFiles).toEqual(["qoder-new.txt", "tracked.txt"]);
    expect(await readFile(session.reviewPatchPath, "utf8")).toContain("qoder result");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user working\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");

    await expect(
      executeWorktreeCommand(["apply", "--state", session.statePath]),
    ).resolves.toMatchObject({
      status: "succeeded",
      operation: "apply",
      cleaned: true,
    });

    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("qoder result\n");
    expect(await readFile(join(root, "qoder-new.txt"), "utf8")).toBe("new code\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");
    expect(git(root, ["diff", "--cached", "--", "tracked.txt"])).toContain("user staged");
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(session.worktreeRoot);
  });

  it("copies configured ignored artifacts without adding them to the review patch", async () => {
    const root = await createFixture();
    await mkdir(join(root, "src/generated/schemas/cache"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "src/generated/\n");
    await writeFile(
      join(root, ".qoderinclude"),
      "# generated types\n/src/generated/schemas/**\n!/src/generated/schemas/cache/**\n",
    );
    await writeFile(join(root, "src/generated/schemas/api.ts"), "export type Api = string;\n");
    await writeFile(join(root, "src/generated/schemas/cache/stale.ts"), "cache\n");
    git(root, ["add", ".gitignore", ".qoderinclude"]);
    git(root, ["commit", "-m", "configure generated artifacts"]);

    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts).toMatchObject({ fileCount: 1 });
    expect(session.includedIgnoredArtifacts?.totalBytes).toBeGreaterThan(0);
    const cliPrepared = await executeWorktreeCommand(["prepare", "--cwd", root]);
    expect(cliPrepared).toMatchObject({
      includedIgnoredArtifacts: { fileCount: 1, totalBytes: 26 },
    });
    await disposeWorktree(String(cliPrepared.statePath), true);
    expect(await readFile(join(session.worktreeRoot, "src/generated/schemas/api.ts"), "utf8")).toBe(
      "export type Api = string;\n",
    );
    expect(
      await pathExists(join(session.worktreeRoot, "src/generated/schemas/cache/stale.ts")),
    ).toBe(false);

    await writeFile(join(session.worktreeRoot, "tracked.txt"), "qoder result\n");
    const review = await createReviewPatch(session.statePath);
    expect(review.changedFiles).toEqual(["tracked.txt"]);
    expect(await readFile(session.reviewPatchPath, "utf8")).not.toContain("generated/schemas");
    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "src/generated/schemas/api.ts"), "utf8")).toBe(
      "export type Api = string;\n",
    );
  });

  it("copies ignored schemas when the host cwd is the repository root", async () => {
    const root = await createFixture();
    const schemaPath = "packages/api/src/schemas/api.gen.ts";
    await mkdir(join(root, "packages/api/src/schemas"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "/**/schemas/**.gen.ts\n");
    await writeFile(join(root, ".qoderinclude"), "packages/api/src/schemas/**\n");
    await writeFile(join(root, schemaPath), "export type Api = string;\n");
    git(root, ["add", ".gitignore", ".qoderinclude"]);
    git(root, ["commit", "-m", "configure root schema context"]);

    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts).toMatchObject({ fileCount: 1 });
    expect(await readFile(join(session.worktreeRoot, schemaPath), "utf8")).toBe(
      "export type Api = string;\n",
    );
    await disposeWorktree(session.statePath, true);
  });

  it("does not copy ignored schemas outside a nested host cwd", async () => {
    const root = await createFixture();
    const hostCwd = join(root, "web/datav/src/pages/335823/instructor");
    const schemaPath = "packages/api/src/schemas/api.gen.ts";
    await mkdir(hostCwd, { recursive: true });
    await writeFile(join(hostCwd, "placeholder.ts"), "export {}\n");
    await mkdir(join(root, "packages/api/src/schemas"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "/**/schemas/**.gen.ts\n");
    await writeFile(join(root, ".qoderinclude"), "packages/api/src/schemas/**\n");
    await writeFile(join(root, schemaPath), "export type Api = string;\n");
    git(root, ["add", ".gitignore", ".qoderinclude", "web"]);
    git(root, ["commit", "-m", "configure nested host context"]);

    const session = await prepareWorktree(hostCwd);
    expect(session.includedIgnoredArtifacts).toMatchObject({ fileCount: 0, totalBytes: 0 });
    expect(await pathExists(join(session.worktreeRoot, schemaPath))).toBe(false);
    expect(
      await pathExists(
        join(session.worktreeRoot, "web/datav/src/pages/335823/instructor/placeholder.ts"),
      ),
    ).toBe(true);
    await disposeWorktree(session.statePath, true);
  });

  it("treats a missing or empty include config as no operation", async () => {
    const missingRoot = await createFixture();
    const missing = await prepareWorktree(missingRoot);
    expect(missing.includedIgnoredArtifacts).toBeNull();
    await disposeWorktree(missing.statePath, true);

    const emptyRoot = await createFixture();
    await writeFile(join(emptyRoot, ".qoderinclude"), "# no dependencies\n\n");
    const empty = await prepareWorktree(emptyRoot);
    expect(empty.includedIgnoredArtifacts).toBeNull();
    await disposeWorktree(empty.statePath, true);
  });

  it("enforces included artifact file and byte limits", () => {
    expect(() => enforceIncludedArtifactLimits(20_001, 0)).toThrowError(
      expect.objectContaining({ code: "include_limit_exceeded" }),
    );
    expect(() => enforceIncludedArtifactLimits(1, 256 * 1024 * 1024 + 1)).toThrowError(
      expect.objectContaining({ code: "include_limit_exceeded" }),
    );
    expect(() => enforceIncludedArtifactLimits(20_000, 256 * 1024 * 1024)).not.toThrow();
  });

  it("writes required v2 state and normalizes only genuine v1 sessions", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    expect(session.version).toBe(2);
    const stored = JSON.parse(await readFile(session.statePath, "utf8")) as Record<string, unknown>;
    stored.version = 1;
    delete stored.includedIgnoredArtifacts;
    await writeFile(session.statePath, `${JSON.stringify(stored)}\n`);

    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      session: { version: 1, includedIgnoredArtifacts: null },
    });
    await disposeWorktree(session.statePath, true);

    const v2 = await prepareWorktree(root);
    const invalid = JSON.parse(await readFile(v2.statePath, "utf8")) as Record<string, unknown>;
    delete invalid.includedIgnoredArtifacts;
    await writeFile(v2.statePath, `${JSON.stringify(invalid)}\n`);
    await expect(inspectWorktree(v2.statePath)).rejects.toMatchObject({ code: "invalid_input" });
    invalid.includedIgnoredArtifacts = null;
    await writeFile(v2.statePath, `${JSON.stringify(invalid)}\n`);
    await disposeWorktree(v2.statePath, true);
  });

  it("reads a v1 artifact manifest without the v2 digest field", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "schema\n");
    const session = await prepareWorktree(root);
    const stored = JSON.parse(await readFile(session.statePath, "utf8")) as {
      version: number;
      includedIgnoredArtifacts: Record<string, unknown>;
    };
    stored.version = 1;
    delete stored.includedIgnoredArtifacts.manifestSha256;
    await writeFile(session.statePath, `${JSON.stringify(stored)}\n`);
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      session: {
        version: 1,
        includedIgnoredArtifacts: { manifestSha256: null, fileCount: 1 },
      },
    });
    await disposeWorktree(session.statePath, true);
  });

  it("excludes modified included artifacts from the review patch", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "original\n");
    const session = await prepareWorktree(root);

    const forged = "forged\n";
    await writeFile(join(session.worktreeRoot, "generated/schema.ts"), forged);
    await writeFile(join(session.worktreeRoot, ".gitignore"), "");
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "candidate\n");
    const review = await createReviewPatch(session.statePath);
    expect(review.changedFiles).toEqual([".gitignore", "tracked.txt"]);
    expect(await readFile(session.reviewPatchPath, "utf8")).not.toContain("generated/schema.ts");
    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "generated/schema.ts"), "utf8")).toBe("original\n");
  });

  it("uses the same artifact exclusion for inspect, diff, reopen, and apply", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "original\n", { mode: 0o644 });
    await writeFile(join(root, "generated/deleted.ts"), "delete me\n");
    const session = await prepareWorktree(root);

    await writeFile(join(session.worktreeRoot, "generated/schema.ts"), "changed\n");
    await chmod(join(session.worktreeRoot, "generated/schema.ts"), 0o600);
    await rm(join(session.worktreeRoot, "generated/deleted.ts"));
    await writeFile(join(session.worktreeRoot, ".gitignore"), "");
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "candidate\n");
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      changedFiles: [".gitignore", "tracked.txt"],
    });
    await expect(createReviewPatch(session.statePath)).resolves.toMatchObject({
      changedFiles: [".gitignore", "tracked.txt"],
    });
    await expect(reopenReviewWorktree(session.statePath)).resolves.toMatchObject({
      changedFiles: [".gitignore", "tracked.txt"],
    });
    await createReviewPatch(session.statePath);
    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "generated/schema.ts"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "generated/deleted.ts"), "utf8")).toBe("delete me\n");
  });

  it("rejects a reviewed index that contains a prepared artifact path", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "original\n");
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "candidate\n");
    await createReviewPatch(session.statePath);
    await writeFile(join(session.worktreeRoot, "generated/schema.ts"), "changed\n");
    git(session.worktreeRoot, ["add", "--force", "generated/schema.ts"]);
    const currentPatch = git(session.worktreeRoot, [
      "diff",
      "--binary",
      "--cached",
      session.baselineTree,
    ]);
    await writeFile(session.reviewPatchPath, currentPatch);
    await expect(applyReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "included_artifact_in_patch",
    });
    await disposeWorktree(session.statePath, true);
  });

  it("excludes a force-added artifact from inspect changes while reporting index drift", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "original\n");
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "generated/schema.ts"), "changed\n");
    git(session.worktreeRoot, ["add", "--force", "generated/schema.ts"]);

    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      hasChanges: false,
      changedFiles: [],
      indexModified: true,
    });
    await expect(createReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "git_index_modified",
    });
    await disposeWorktree(session.statePath, true);
  });

  it.each(["inspect", "diff", "reopen", "apply"] as const)(
    "rejects a damaged artifact manifest before %s",
    async (operation) => {
      const root = await createFixture();
      await mkdir(join(root, "generated"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "generated/\n");
      await writeFile(join(root, ".qoderinclude"), "generated/**\n");
      await writeFile(join(root, "generated/schema.ts"), "schema\n");
      const session = await prepareWorktree(root);
      if (operation === "reopen" || operation === "apply") {
        await writeFile(join(session.worktreeRoot, "tracked.txt"), "candidate\n");
        await createReviewPatch(session.statePath);
      }
      await writeFile(session.includedIgnoredArtifacts?.manifestPath ?? "", "{}\n");
      const action =
        operation === "inspect"
          ? inspectWorktree(session.statePath)
          : operation === "diff"
            ? createReviewPatch(session.statePath)
            : operation === "reopen"
              ? reopenReviewWorktree(session.statePath)
              : applyReviewPatch(session.statePath);
      await expect(action).rejects.toMatchObject({
        code: "included_artifact_snapshot_invalid",
      });
      await disposeWorktree(session.statePath, true);
    },
  );

  it("applies ordered include, exclude, and re-include rules", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated/cache"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(
      join(root, ".qoderinclude"),
      "generated/**\n!generated/cache/**\ngenerated/cache/keep.ts\n",
    );
    await writeFile(join(root, "generated/api.ts"), "api\n");
    await writeFile(join(root, "generated/cache/drop.ts"), "drop\n");
    await writeFile(join(root, "generated/cache/keep.ts"), "keep\n");

    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts?.fileCount).toBe(2);
    expect(await pathExists(join(session.worktreeRoot, "generated/api.ts"))).toBe(true);
    expect(await pathExists(join(session.worktreeRoot, "generated/cache/drop.ts"))).toBe(false);
    expect(await pathExists(join(session.worktreeRoot, "generated/cache/keep.ts"))).toBe(true);
    await disposeWorktree(session.statePath, true);
  });

  it("allows optional rules with missing, tracked, and non-ignored matches", async () => {
    const root = await createFixture();
    await writeFile(join(root, "local.txt"), "local\n");
    await writeFile(
      join(root, ".qoderinclude"),
      "generated/missing.ts\ngenerated/schemas/**\ntracked.txt\nlocal.txt\n",
    );
    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts).toMatchObject({ fileCount: 0, totalBytes: 0 });
    expect(await pathExists(session.includedIgnoredArtifacts?.manifestPath ?? "")).toBe(true);
    await disposeWorktree(session.statePath, true);
  });

  it("rejects invalid include paths and glob syntax", async () => {
    const invalidRoot = await createFixture();
    await writeFile(join(invalidRoot, ".qoderinclude"), "../secret\n");
    await expect(prepareWorktree(invalidRoot)).rejects.toMatchObject({
      code: "invalid_include_config",
    });

    const globRoot = await createFixture();
    await writeFile(join(globRoot, ".qoderinclude"), "generated/[abc\n");
    await expect(prepareWorktree(globRoot)).rejects.toMatchObject({
      code: "invalid_include_config",
    });
  });

  it("copies only included artifacts inside the requested cwd scope", async () => {
    const root = await createFixture();
    await mkdir(join(root, "packages/a/generated"), { recursive: true });
    await mkdir(join(root, "packages/b/generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "packages/*/generated/\n");
    await writeFile(join(root, ".qoderinclude"), "packages/*/generated/**\n");
    await writeFile(join(root, "packages/a/generated/a.ts"), "a\n");
    await writeFile(join(root, "packages/b/generated/b.ts"), "b\n");

    const session = await prepareWorktree(join(root, "packages/a"));
    expect(session.includedIgnoredArtifacts?.fileCount).toBe(1);
    expect(await pathExists(join(session.worktreeRoot, "packages/a/generated/a.ts"))).toBe(true);
    expect(await pathExists(join(session.worktreeRoot, "packages/b/generated/b.ts"))).toBe(false);
    await disposeWorktree(session.statePath, true);
  });

  it("supports root and single-level glob rules", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "/*.json\n/generated/*.ts\n");
    await writeFile(join(root, ".qoderinclude"), "*.json\ngenerated/*.ts\n");
    await writeFile(join(root, "schema.json"), "{}\n");
    await writeFile(join(root, "generated/api.ts"), "api\n");
    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts?.fileCount).toBe(2);
    expect(await pathExists(join(session.worktreeRoot, "schema.json"))).toBe(true);
    expect(await pathExists(join(session.worktreeRoot, "generated/api.ts"))).toBe(true);
    await disposeWorktree(session.statePath, true);
  });

  it("fails real prepare capacity preflight and cleans its temporary session", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/huge.bin"), "");
    await truncate(join(root, "generated/huge.bin"), 256 * 1024 * 1024 + 1);
    const before = await listSessionRoots();
    await expect(prepareWorktree(root)).rejects.toMatchObject({ code: "include_limit_exceeded" });
    expect(await listSessionRoots()).toEqual(before);
    expect(git(root, ["worktree", "list", "--porcelain"]).match(/worktree /g)).toHaveLength(1);
  });

  it("cleans a real prepare that selects too many artifact files", async () => {
    const root = await createFixture();
    const generated = join(root, "generated");
    await mkdir(generated, { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    for (let start = 0; start < 20_001; start += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, 20_001 - start) }, (_, offset) =>
          writeFile(join(generated, `${start + offset}.txt`), ""),
        ),
      );
    }
    const before = await listSessionRoots();
    await expect(prepareWorktree(root)).rejects.toMatchObject({ code: "include_limit_exceeded" });
    expect(await listSessionRoots()).toEqual(before);
    expect(git(root, ["worktree", "list", "--porcelain"]).match(/worktree /g)).toHaveLength(1);
  });

  it("supports repository-internal relative symlinks and rejects escaping symlinks", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "schema\n");
    await symlink("schema.ts", join(root, "generated/current.ts"));

    const session = await prepareWorktree(root);
    expect(session.includedIgnoredArtifacts?.fileCount).toBe(2);
    await disposeWorktree(session.statePath, true);

    await rm(join(root, "generated/current.ts"));
    await symlink("../../tracked.txt", join(root, "generated/current.ts"));
    await expect(prepareWorktree(root)).rejects.toMatchObject({
      code: "unsupported_included_artifact",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects glob-matched and exact special files inside selected ignored roots",
    async () => {
      const root = await createFixture();
      await mkdir(join(root, "generated"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "generated/\n");
      await writeFile(join(root, ".qoderinclude"), "generated/**\n");
      await writeFile(join(root, "generated/schema.ts"), "schema\n");
      execFileSync("mkfifo", [join(root, "generated/schema.pipe")]);

      await expect(prepareWorktree(root)).rejects.toMatchObject({
        code: "unsupported_included_artifact",
      });
      await writeFile(join(root, ".qoderinclude"), "generated/schema.pipe\n");
      await expect(prepareWorktree(root)).rejects.toMatchObject({
        code: "unsupported_included_artifact",
      });
    },
  );

  it("does not modify the source when the reviewed patch no longer applies", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "qoder result\n");
    await createReviewPatch(session.statePath);
    await writeFile(join(root, "tracked.txt"), "concurrent source edit\n");

    await expect(applyReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "apply_conflict",
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("concurrent source edit\n");
    expect(await pathExists(session.worktreeRoot)).toBe(true);
    expect(await pathExists(session.sessionRoot)).toBe(true);

    await disposeWorktree(session.statePath, true);
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
  });

  it("reopens a rejected candidate in place and applies the corrected complete result", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "accepted first-pass work\n");
    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "broken first pass\n");
    const firstReview = await createReviewPatch(session.statePath);
    const firstPatch = await readFile(firstReview.session.reviewPatchPath, "utf8");

    const reopened = await executeWorktreeCommand(["reopen", "--state", session.statePath]);
    expect(reopened).toMatchObject({
      status: "succeeded",
      operation: "reopen",
      phase: "prepared",
      statePath: await realpath(session.statePath),
      qoderCwd: session.worktreeCwd,
      changedFiles: ["qoder-new.txt", "tracked.txt"],
      indexModified: false,
      reviewAttempt: 1,
    });
    expect(await readFile(join(session.worktreeRoot, "tracked.txt"), "utf8")).toBe(
      "accepted first-pass work\n",
    );
    expect(await readFile(join(session.worktreeRoot, "qoder-new.txt"), "utf8")).toBe(
      "broken first pass\n",
    );
    expect(await readFile(String(reopened.archivedPatchPath), "utf8")).toBe(firstPatch);
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      indexModified: false,
      session: { phase: "prepared", reviewAttempt: 1 },
    });

    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "fixed second pass\n");
    const secondReview = await createReviewPatch(session.statePath);
    expect(secondReview.session.reviewAttempt).toBe(2);
    const finalPatch = await readFile(session.reviewPatchPath, "utf8");
    expect(finalPatch).toContain("accepted first-pass work");
    expect(finalPatch).toContain("fixed second pass");

    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("accepted first-pass work\n");
    expect(await readFile(join(root, "qoder-new.txt"), "utf8")).toBe("fixed second pass\n");
  });

  it("refuses to reopen a reviewed worktree that drifted after patch generation", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "reviewed candidate\n");
    await createReviewPatch(session.statePath);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "post-review drift\n");

    await expect(reopenReviewWorktree(session.statePath)).rejects.toMatchObject({
      code: "review_state_changed",
    });
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      session: { phase: "review_ready", reviewAttempt: 1 },
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");

    await disposeWorktree(session.statePath, true);
  });

  it("continues a trustworthy failed Runner attempt in the same prepared worktree", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "partial failed-run work\n");

    const failedRunInspection = await executeWorktreeCommand([
      "inspect",
      "--state",
      session.statePath,
    ]);
    expect(failedRunInspection).toMatchObject({
      phase: "prepared",
      qoderCwd: session.worktreeCwd,
      hasChanges: true,
      changedFiles: ["tracked.txt"],
      indexModified: false,
    });

    await writeFile(join(session.worktreeRoot, "tracked.txt"), "completed recovery work\n");
    await createReviewPatch(session.statePath);
    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("completed recovery work\n");
  });

  it("disposes a linked retry chain after the newest session applies", async () => {
    const root = await createFixture();
    const first = await prepareWorktree(root);
    await writeFile(join(first.worktreeRoot, "tracked.txt"), "partial retry result\n");

    const second = await prepareWorktree(root, first.statePath);
    expect(second.retryOf).toBe(await realpath(first.statePath));
    await writeFile(join(second.worktreeRoot, "tracked.txt"), "final retry result\n");
    await createReviewPatch(second.statePath);

    await expect(
      executeWorktreeCommand(["apply", "--state", second.statePath]),
    ).resolves.toMatchObject({
      status: "succeeded",
      operation: "apply",
      cleaned: true,
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("final retry result\n");
    expect(await pathExists(first.worktreeRoot)).toBe(false);
    expect(await pathExists(first.sessionRoot)).toBe(false);
    expect(await pathExists(second.worktreeRoot)).toBe(false);
    expect(await pathExists(second.sessionRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(first.worktreeRoot);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(second.worktreeRoot);
  });

  it("retains a linked retry chain when the newest apply conflicts", async () => {
    const root = await createFixture();
    const first = await prepareWorktree(root);
    const second = await prepareWorktree(root, first.statePath);
    await writeFile(join(second.worktreeRoot, "tracked.txt"), "retry result\n");
    await createReviewPatch(second.statePath);
    await writeFile(join(root, "tracked.txt"), "concurrent source edit\n");

    await expect(applyReviewPatch(second.statePath)).rejects.toMatchObject({
      code: "apply_conflict",
    });
    expect(await pathExists(first.worktreeRoot)).toBe(true);
    expect(await pathExists(first.sessionRoot)).toBe(true);
    expect(await pathExists(second.worktreeRoot)).toBe(true);
    expect(await pathExists(second.sessionRoot)).toBe(true);

    await disposeWorktree(second.statePath, true);
    await disposeWorktree(first.statePath, true);
  });

  it("rejects a retry session from another source worktree", async () => {
    const firstRoot = await createFixture();
    const secondRoot = await createFixture();
    const first = await prepareWorktree(firstRoot);

    await expect(prepareWorktree(secondRoot, first.statePath)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await disposeWorktree(first.statePath, true);
  });

  it("requires discard before disposing an unapplied session", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);

    await expect(disposeWorktree(session.statePath, false)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect(await pathExists(session.worktreeRoot)).toBe(true);

    await disposeWorktree(session.statePath, true);
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
  });

  it("stops if Qoder changes the temporary Git index", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "staged by qoder\n");
    git(session.worktreeRoot, ["add", "tracked.txt"]);

    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      hasChanges: true,
      changedFiles: ["tracked.txt"],
      indexModified: true,
      session: { phase: "prepared" },
    });

    await expect(createReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "git_index_modified",
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");

    await disposeWorktree(session.statePath, true);
  });
});

describe("generated worktree executable", () => {
  it("prepares configured ignored artifacts through the standalone bundle", async () => {
    const root = await createFixture();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, ".qoderinclude"), "generated/**\n");
    await writeFile(join(root, "generated/schema.ts"), "schema\n");

    const executed = spawnSync(process.execPath, [worktreeRunnerPath, "prepare", "--cwd", root], {
      encoding: "utf8",
    });
    const result = JSON.parse(executed.stdout.trim()) as Record<string, unknown>;
    expect(executed.status).toBe(0);
    expect(result).toMatchObject({
      status: "succeeded",
      includedIgnoredArtifacts: { fileCount: 1, totalBytes: 7 },
    });
    await disposeWorktree(String(result.statePath), true);
  });

  it("does not execute a command when imported", () => {
    const importScript = `await import(${JSON.stringify(pathToFileURL(worktreeRunnerPath).href)});`;
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], {
      encoding: "utf8",
    });

    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
  });

  it("emits one JSON failure for invalid direct input", () => {
    const executed = spawnSync(process.execPath, [worktreeRunnerPath], { encoding: "utf8" });
    const lines = executed.stdout.trim().split("\n");
    const result = JSON.parse(lines[0] ?? "{}");

    expect(executed.status).not.toBe(0);
    expect(lines).toHaveLength(1);
    expect(executed.stderr).toBe("");
    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  });
});
