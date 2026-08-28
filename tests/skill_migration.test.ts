import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Qoder Skill Task migration", () => {
  it("uses only the task-aware CLI for the normal Skill lifecycle", async () => {
    const skill = await source("skills/qoder-agent/SKILL.md");
    const review = await source("skills/qoder-agent/references/worktree-review.md");
    const protocol = await source("skills/qoder-agent/references/protocol.md");

    expect(skill).toContain("scripts/qoder_agent_task.mjs");
    expect(skill).toContain("qoder_agent_task.mjs start");
    expect(skill).toContain("qoder_agent_task.mjs inspect");
    expect(review).toContain("qoder_agent_task.mjs candidate");
    expect(review).toContain("qoder_agent_task.mjs repair");
    expect(review).toContain("qoder_agent_task.mjs apply");
    expect(protocol).toContain('"resultRef"');

    expect(skill).not.toMatch(/qoder_worktree\.mjs\s+(prepare|diff|reopen|apply)/u);
    expect(skill).not.toMatch(/run_qoder\.mjs\s+\\?\s*--cwd/u);
    expect(review).not.toMatch(/qoder_worktree\.mjs\s+(prepare|inspect|diff|reopen|apply)/u);
    expect(review).not.toMatch(/qoder_agent_task\.mjs\s+recover/u);
  });

  it("uses task-facing workspace disclosure and opaque retry preparation", async () => {
    const skill = await source("skills/qoder-agent/SKILL.md");
    const review = await source("skills/qoder-agent/references/worktree-review.md");
    const delegation = await source("skills/qoder-agent/references/delegation-prompt.md");

    for (const text of [skill, review, delegation]) {
      expect(text).toContain("workspace.cwd");
      expect(text).not.toContain("qoderCwd");
      expect(text).not.toContain("preparedStatePath");
      expect(text).not.toContain("--prepared-state");
    }

    expect(skill).toContain("--strategy continue");
    expect(skill).toContain("--strategy restart");
    expect(review).toContain("preparationId");
    expect(review).toContain("--preparation <preparationId>");
    expect(review).toContain("retryEligibility.current === true");
    expect(review).toContain("No retry is automatic");
  });

  it("keeps Runner execution policy in Host and uses one pre-MCP blocking wait profile", async () => {
    const skill = await source("skills/qoder-agent/SKILL.md");
    const protocol = await source("skills/qoder-agent/references/protocol.md");

    for (const text of [skill, protocol]) {
      expect(text).not.toMatch(/qoder_agent_task[^\n]*--timeout-ms/u);
      expect(text).not.toMatch(/qoder_agent_task[^\n]*--max-model-request-retries/u);
      expect(text).not.toMatch(/qoder_agent_task[^\n]*--qodercli-path/u);
    }

    expect(protocol).toContain("QODER_TASK_TIMEOUT_MS");
    expect(protocol).toContain("QODER_TASK_MAX_MODEL_REQUEST_RETRIES");
    expect(protocol).toContain('"executionPolicy"');
    expect(protocol).toContain('"operability": "normal"');

    expect(skill).toContain("host-tool wait budget");
    expect(skill.replace(/\s+/gu, " ")).toContain("do not perform unrelated work between waits");
    expect(protocol).toContain("pre-MCP compatibility shim");
    expect(protocol).toContain("initial startup yield: 15000 ms");
    expect(protocol).toContain('"yield_time_ms": 300000');
    expect(protocol).toContain("yield_time_ms: 280000");
    expect(protocol).toContain("exactly one empty-stdin wait");
    expect(protocol).toContain("Do not issue shorter or higher-frequency waits");
  });

  it("keeps authored Skill source separate from generated distribution artifacts", async () => {
    const config = await source("tsdown.config.ts");
    const builder = await source("scripts/build_skill.mjs");
    const validator = await source("scripts/validate_skill_distribution.mjs");
    const packageJson = await source("package.json");

    expect(config).not.toContain("skills/qoder-agent/scripts");
    expect(builder).toContain('resolve(root, "skills/qoder-agent")');
    expect(validator).toContain('resolve(root, "skills/qoder-agent")');
    expect(builder).toContain("dist/skills/qoder-agent");
    expect(builder).toContain('"SKILL.md", "agents", "references"');
    expect(builder).toContain("for (const [name, entry] of Object.entries(standaloneEntries))");
    expect(builder).toContain("entry: { [name]: entry }");
    expect(builder).toContain("manifest.json");
    expect(validator).toContain("Skill manifest file set does not match");
    expect(validator).toContain("must inline @qoder-agent-bridge/core");
    expect(validator).toContain('const directories = ["agents", "references"]');
    expect(validator).toContain('const result = ["SKILL.md"]');
    expect(packageJson).toContain('"skill:build": "node scripts/build_skill.mjs"');
    expect(packageJson).toContain(
      '"skill:validate": "node scripts/validate_skill.mjs dist/skills/qoder-agent && node scripts/validate_skill_distribution.mjs"',
    );
    expect(packageJson).not.toContain("skill:artifacts:check");
  });

  it("packs one installable ZIP and releases only exact version tags on Linux", async () => {
    const packer = await source("scripts/pack_skill.mjs");
    const packageJson = await source("package.json");
    const ci = await source(".github/workflows/ci.yml");
    const release = await source(".github/workflows/release.yml");

    expect(packageJson).toContain('"skill:pack": "node scripts/pack_skill.mjs"');
    expect(packer).toContain("qoder-agent-${expectedTag}.zip");
    expect(packer).toContain("Formal releases require a clean Git checkout");
    expect(packer).toContain("Formal release tag ${tag} must point at HEAD");
    expect(packer).toContain('"qoder-agent/manifest.json"');
    expect(packer).toContain("unzip");

    expect(ci).toContain("runs-on: ubuntu-latest");
    expect(ci).not.toContain("matrix:");
    expect(ci).toContain("pnpm skill:pack");

    expect(release).toContain('tags:\n      - "v*"');
    expect(release).not.toContain("workflow_dispatch");
    expect(release).toContain('expected="v${version}"');
    expect(release).toContain("node scripts/pack_skill.mjs --release");
    expect(release).toContain("gh release create");
    expect(release).toContain("--draft");
    expect(release).toContain('gh release view "${tag}" --json isImmutable');
    expect(release).toContain("for attempt in $(seq 1 18)");
    expect(release).toContain("sleep 5");
    expect(release).toContain("gh release verify");
    expect(release).toContain("Leaving the published release untouched");
    expect(release).not.toContain('gh release delete "${tag}"');
  });
});
