#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const distRoot = resolve(root, "dist/skills/qoder-agent");
const releaseRoot = resolve(root, "dist/releases");
const releaseMode = process.argv.includes("--release");
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== "--release");

if (unexpectedArgs.length > 0) {
  throw new Error(`Unknown pack arguments: ${unexpectedArgs.join(", ")}`);
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;
const expectedTag = `v${version}`;
let releaseHead = null;

if (releaseMode) {
  releaseHead = await verifyReleaseCheckout(expectedTag);
}

await runNode("scripts/build_skill.mjs");
await runNode("scripts/validate_skill.mjs", [distRoot]);
await runNode("scripts/validate_skill_distribution.mjs");

const manifest = JSON.parse(await readFile(resolve(distRoot, "manifest.json"), "utf8"));
if (releaseMode) {
  if (manifest.sourceRevision !== releaseHead) {
    throw new Error(
      `Release manifest sourceRevision must equal HEAD (${releaseHead}); found ${manifest.sourceRevision ?? "null"}.`,
    );
  }
  if (manifest.dirty !== false) {
    throw new Error("Formal release manifests must record dirty=false.");
  }
}

await mkdir(releaseRoot, { recursive: true });
const archiveName = `qoder-agent-${expectedTag}.zip`;
const archivePath = resolve(releaseRoot, archiveName);
await rm(archivePath, { force: true });

await execFileAsync("zip", ["-q", "-r", archivePath, "qoder-agent"], {
  cwd: resolve(root, "dist/skills"),
});
await validateArchive(archivePath, manifest);

process.stdout.write(`${archivePath}\n`);

async function verifyReleaseCheckout(tag) {
  const [{ stdout: headOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root }),
  ]);
  const head = headOutput.trim();
  if (statusOutput.trim() !== "") {
    throw new Error("Formal releases require a clean Git checkout.");
  }

  let tagCommit;
  try {
    ({ stdout: tagCommit } = await execFileAsync("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], {
      cwd: root,
    }));
  } catch {
    throw new Error(`Formal release tag ${tag} does not exist.`);
  }
  if (tagCommit.trim() !== head) {
    throw new Error(`Formal release tag ${tag} must point at HEAD ${head}.`);
  }

  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== tag)
  ) {
    throw new Error(`GitHub release checkout must be triggered by the exact tag ${tag}.`);
  }

  return head;
}

async function validateArchive(archivePath, manifest) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("unzip", ["-Z1", archivePath], { cwd: root }));
  } catch {
    throw new Error("Unable to inspect Skill ZIP; the `unzip` command is required.");
  }

  const actualFiles = stdout
    .split(/\r?\n/u)
    .filter((path) => path !== "" && !path.endsWith("/"))
    .sort();
  const expectedFiles = [
    "qoder-agent/manifest.json",
    ...manifest.files.map((entry) => `qoder-agent/${entry.path}`),
  ].sort();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Skill ZIP file set mismatch. Expected ${JSON.stringify(expectedFiles)}, found ${JSON.stringify(actualFiles)}.`,
    );
  }
}

async function runNode(script, args = []) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve(root, script), ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${script} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}
