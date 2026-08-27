import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "skills/qoder-agent");
const distRoot = resolve(root, "dist/skills/qoder-agent");
const scripts = ["qoder_agent_task.mjs", "qoder_worktree.mjs", "run_qoder.mjs"];

const manifest = JSON.parse(await readFile(resolve(distRoot, "manifest.json"), "utf8"));
if (manifest.license !== "MIT") throw new Error("Skill manifest license must be MIT.");
if (
  manifest.version !== JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version
) {
  throw new Error("Skill manifest version must match root package.json.version.");
}

const actualFiles = (await listFiles(distRoot))
  .map((path) => relative(distRoot, path).split(sep).join("/"))
  .filter((path) => path !== "manifest.json")
  .sort();
const manifestFiles = manifest.files.map((entry) => entry.path).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(manifestFiles)) {
  throw new Error("Skill manifest file set does not match the distribution file set.");
}

for (const entry of manifest.files) {
  const buffer = await readFile(resolve(distRoot, entry.path));
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (buffer.byteLength !== entry.size || sha256 !== entry.sha256) {
    throw new Error(`Skill manifest metadata mismatch for ${entry.path}.`);
  }
}

for (const authoredPath of await authoredFiles()) {
  const source = await readFile(resolve(sourceRoot, authoredPath));
  const distributed = await readFile(resolve(distRoot, authoredPath));
  if (!source.equals(distributed))
    throw new Error(`Authored Skill file changed during packaging: ${authoredPath}`);
}

const distributedScripts = (await readdir(resolve(distRoot, "scripts")))
  .filter((name) => name.endsWith(".mjs"))
  .sort();
const expectedScripts = [...scripts].sort();
if (JSON.stringify(distributedScripts) !== JSON.stringify(expectedScripts)) {
  throw new Error(
    `Skill distribution must contain exactly the three standalone scripts. Expected ${expectedScripts.join(", ")}; found ${distributedScripts.join(", ")}.`,
  );
}

for (const script of scripts) {
  const path = resolve(distRoot, "scripts", script);
  const source = await readFile(path, "utf8");
  if (source.includes("@qoder-agent-bridge/core")) {
    throw new Error(`${script} must inline @qoder-agent-bridge/core.`);
  }
  if (/\b(?:from|import)\s*\(?\s*["']\.\.?\//u.test(source)) {
    throw new Error(`${script} must not have relative runtime dependencies.`);
  }
  await execFileAsync(process.execPath, ["--check", path], { cwd: root });
}

async function authoredFiles() {
  const directories = ["agents", "references"];
  const result = ["SKILL.md"];
  for (const authoredDirectory of directories) {
    const path = resolve(sourceRoot, authoredDirectory);
    const files = await listFiles(path);
    result.push(...files.map((file) => relative(sourceRoot, file).split(sep).join("/")));
  }
  return result.sort();
}

async function listFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
