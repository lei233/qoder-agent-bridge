import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const coreSpecifier = 'from "@qoder-agent-bridge/core"';
const packageOutputs = [
  "packages/cli/dist/run-qoder.js",
  "packages/cli/dist/qoder-worktree.js",
  "packages/cli/dist/qoder-agent-task.js",
];
const skillOutputs = [
  "skill/qoder-agent/scripts/run_qoder.mjs",
  "skill/qoder-agent/scripts/qoder_worktree.mjs",
];

for (const relativePath of packageOutputs) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, "utf8");
  if (!source.includes(coreSpecifier)) {
    throw new Error(`${relativePath} must import core through its package boundary.`);
  }
  if (((await stat(path)).mode & 0o111) === 0) {
    throw new Error(`${relativePath} must be executable.`);
  }
}

const generatedFiles = (await readdir(resolve(root, "skill/qoder-agent/scripts")))
  .filter((name) => name.endsWith(".mjs"))
  .sort();
const expectedFiles = skillOutputs.map((path) => path.split("/").at(-1)).sort();
if (JSON.stringify(generatedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Skill build must contain exactly the two standalone executable artifacts.");
}

for (const relativePath of skillOutputs) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, "utf8");
  if (source.includes("@qoder-agent-bridge/core") || /from\s+["']\.\//.test(source)) {
    throw new Error(`${relativePath} must inline core and remain independently executable.`);
  }
  if (((await stat(path)).mode & 0o111) === 0) {
    throw new Error(`${relativePath} must be executable.`);
  }
}
