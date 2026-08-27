import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { build } from "tsdown";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "skills/qoder-agent");
const distRoot = resolve(root, "dist/skills/qoder-agent");
const scriptsRoot = resolve(distRoot, "scripts");
const authoredRoots = ["SKILL.md", "agents", "references"];
const standaloneEntries = {
  run_qoder: "packages/cli/src/run-qoder.ts",
  qoder_worktree: "packages/cli/src/qoder-worktree.ts",
  qoder_agent_task: "packages/cli/src/qoder-agent-task.ts",
};

process.chdir(root);
await rm(distRoot, { recursive: true, force: true });
await mkdir(scriptsRoot, { recursive: true });

for (const authoredRoot of authoredRoots) {
  await cp(resolve(sourceRoot, authoredRoot), resolve(distRoot, authoredRoot), { recursive: true });
}

for (const [name, entry] of Object.entries(standaloneEntries)) {
  await build({
    config: false,
    entry: { [name]: entry },
    outDir: scriptsRoot,
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    report: false,
    deps: { alwaysBundle: ["@qoder-agent-bridge/core"] },
  });
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const git = await gitMetadata();
const files = [];
for (const path of await listFiles(distRoot)) {
  const buffer = await readFile(path);
  files.push({
    path: relative(distRoot, path).split(sep).join("/"),
    size: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  });
}
files.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  formatVersion: 1,
  version: packageJson.version,
  sourceRevision: git.sourceRevision,
  dirty: git.dirty,
  license: "MIT",
  runtime: {
    node: packageJson.engines?.node ?? ">=22.18.0",
    requires: ["git", "qodercli"],
  },
  files,
};
await writeFile(resolve(distRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function gitMetadata() {
  try {
    const [{ stdout: revision }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root }),
    ]);
    return { sourceRevision: revision.trim(), dirty: statusOutput.trim().length > 0 };
  } catch {
    return { sourceRevision: null, dirty: false };
  }
}
