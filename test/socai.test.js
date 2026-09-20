import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildResearchArgs,
  buildSearchArgs,
  buildTikTokVideoArgs,
  parseJsonOutput,
  probeSocai,
  runSocaiResearch,
  runSocaiSearch,
} from "../src/socai.js";

test("buildSearchArgs owns the stable socai CLI contract", () => {
  assert.deepEqual(buildSearchArgs("tiktok", "AI creator", 12), [
    "tiktok",
    "search",
    "AI creator",
    "--num",
    "12",
    "--pretty",
  ]);
  assert.throws(() => buildSearchArgs("tiktok", "x", 0), /between 1 and 100/);
  assert.deepEqual(buildSearchArgs("linkedin", "AI PM", 8), [
    "linkedin",
    "search",
    "AI PM",
    "--num",
    "8",
    "--pretty",
  ]);
  assert.deepEqual(buildSearchArgs("instagram", "AI wearables", 10), [
    "instagram",
    "search",
    "AI wearables",
    "--num",
    "10",
    "--pretty",
  ]);
});

test("buildTikTokVideoArgs requests real media downloads for every result", () => {
  assert.deepEqual(buildTikTokVideoArgs(["https://www.tiktok.com/@demo/video/123", "456"]), [
    "tiktok",
    "get-videos",
    "--video",
    "https://www.tiktok.com/@demo/video/123",
    "--video",
    "456",
    "--num-comments",
    "8",
    "--download-media",
    "--pretty",
  ]);
});

test("buildResearchArgs owns the non-interactive agent contract", () => {
  assert.deepEqual(buildResearchArgs("instagram", "Compare creator signals", { maxSteps: 8 }), [
    "research",
    "Compare creator signals",
    "--platform",
    "instagram",
    "--max-steps",
    "8",
    "--pretty",
  ]);
  assert.throws(() => buildResearchArgs("instagram", "x", { maxSteps: 31 }), /between 1 and 30/);
});

test("runSocaiResearch streams progress and parses the report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-research-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "research" && args[1] === "--help") console.log("Run research");
else if (args[0] === "research") {
  console.error("Research step 1");
  console.log(JSON.stringify({ ok: true, report: "# Findings\\nEvidence-backed result." }));
} else process.exitCode = 2;
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);
  const progress = [];
  try {
    const result = await runSocaiResearch({
      env: { ...process.env, SOCAI_BIN: mock },
      platform: "instagram",
      task: "Compare creators",
      maxSteps: 6,
      onProgress: (message) => progress.push(message),
    });
    assert.match(result.data.report, /Evidence-backed/);
    assert.match(progress.join(""), /Research step 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseJsonOutput accepts plain and warning-prefixed JSON", () => {
  assert.deepEqual(parseJsonOutput('{"items":[1]}'), { items: [1] });
  assert.deepEqual(parseJsonOutput('update available\n{\n  "items": [2]\n}'), { items: [2] });
});

test("runSocaiSearch capability-checks and parses the real child process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-test-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("socai mock");
} else if (args[0] === "tiktok" && args[1] === "--help") {
  console.log("Commands: search");
} else if (args[0] === "instagram" && args[1] === "--help") {
  process.exitCode = 2;
} else if (args[0] === "tiktok" && args[1] === "search") {
  console.error("reading TikTok");
  console.log(JSON.stringify({ results: [{ title: args[2] }], received: args, leakedKey: process.env.OPENROUTER_API_KEY || null }));
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const env = { ...process.env, SOCAI_BIN: mock, OPENROUTER_API_KEY: "must-not-leak" };
    const status = await probeSocai({}, env);
    assert.equal(status.installed, true);
    assert.deepEqual(status.capabilities, { instagram: false, tiktok: true, linkedin: false });

    const progress = [];
    const result = await runSocaiSearch({
      env,
      platform: "tiktok",
      query: "wearable AI",
      limit: 3,
      onProgress: (message) => progress.push(message),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.results[0].title, "wearable AI");
    assert.equal(result.data.leakedKey, null);
    assert.match(result.command, /tiktok search/);
    assert.match(progress.join(""), /reading TikTok/);

    await assert.rejects(
      runSocaiSearch({ env, platform: "instagram", query: "x", limit: 2 }),
      (error) => error.code === "SOCAI_CAPABILITY_MISSING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runSocaiSearch cancels an in-flight capability probe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-abort-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(mock, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  await chmod(mock, 0o755);
  const controller = new AbortController();
  try {
    const pending = runSocaiSearch({
      env: { ...process.env, SOCAI_BIN: mock },
      platform: "tiktok",
      query: "demo",
      limit: 1,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(pending, (error) => error.code === "SOCAI_ABORTED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("probeSocai extracts semver version, evaluates per-platform capabilities, and leaks no paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-probe-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("socai version 0.5.6-beta.1 (x86_64-linux)");
} else if (args[0] === "--help") {
  console.log("socai root help");
} else if (args[0] === "instagram" && args[1] === "--help") {
  console.log("Commands: search");
} else if (args[0] === "tiktok" && args[1] === "--help") {
  console.log("Commands: search");
} else if (args[0] === "linkedin" && args[1] === "--help") {
  console.log("Unknown platform");
  process.exitCode = 1;
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const env = { ...process.env, SOCAI_BIN: mock };
    const status = await probeSocai({}, env);
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.5.6-beta.1");
    assert.deepEqual(status.capabilities, {
      instagram: true,
      tiktok: true,
      linkedin: false,
    });
    assert.equal(status.bin, mock, "probeSocai must retain bin internally for CLI callers");
    assert.equal(status.configPath, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizeCliErrorText redacts all types of system paths including /opt, /usr, /var, tildes and spawn ENOENT", async () => {
  const { sanitizeCliErrorText } = await import("../src/socai.js");
  
  assert.equal(
    sanitizeCliErrorText("Error: cannot exec /opt/homebrew/bin/socai"),
    "Error: cannot exec [path]",
  );
  assert.equal(
    sanitizeCliErrorText("spawn /usr/local/bin/socai ENOENT"),
    "spawn [path] ENOENT",
  );
  assert.equal(
    sanitizeCliErrorText("spawn /Volumes/My Disk/socai ENOENT"),
    "spawn [path] ENOENT",
  );
  assert.equal(
    sanitizeCliErrorText("spawn '/Volumes/My Disk/socai' ENOENT"),
    "spawn [path] ENOENT",
  );
  assert.equal(
    sanitizeCliErrorText("Error: C:\\Program Files\\socai\\socai.exe not found"),
    "Error: [path] not found",
  );
  assert.equal(
    sanitizeCliErrorText('"C:\\Program Files\\socai\\socai.exe" is not recognized'),
    "[path] is not recognized",
  );
  assert.equal(
    sanitizeCliErrorText("/usr/local/bin/socai exited with code 1"),
    "[path] exited with code 1",
  );
  assert.equal(
    sanitizeCliErrorText("socai: /var/log/socai.err: Permission denied"),
    "socai: [path]: Permission denied",
  );
  assert.equal(
    sanitizeCliErrorText("cannot load configuration from ~/.socai/config.json"),
    "cannot load configuration from [path]",
  );
  assert.equal(
    sanitizeCliErrorText("error in ./bin/socai script"),
    "error in [path] script",
  );
  assert.equal(
    sanitizeCliErrorText("socai v0.5.6 (3/3 ready)"),
    "socai v0.5.6 (3/3 ready)",
    "Non-path phrases like (3/3 ready) must not be corrupted",
  );
  assert.equal(
    sanitizeCliErrorText("See https://example.com/docs/troubleshooting"),
    "See https://example.com/docs/troubleshooting",
    "HTTPS URLs must be preserved intact",
  );
  assert.equal(
    sanitizeCliErrorText("See http://internal.local/status"),
    "See http://internal.local/status",
    "HTTP URLs must be preserved intact",
  );
  assert.equal(
    sanitizeCliErrorText("Visit https://socai.dev/auth?token=abc for help (logged to /var/log/socai.err)"),
    "Visit https://socai.dev/auth?token=abc for help (logged to [path])",
    "URLs must remain intact while local filesystem paths in same error are redacted",
  );
});

test("platformSupported returns false when help text mentions 'search' but the subcommand is absent", async () => {
  const { platformSupported } = await import("../src/socai.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-neg-help-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "linkedin" && args[1] === "--help") {
  console.log("linkedin search is unavailable in this build\\nCommands: profile company");
} else if (args[0] === "linkedin" && args[1] === "search" && args[2] === "--help") {
  console.error("unknown command: search");
  process.exitCode = 1;
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const isSupported = await platformSupported(mock, "linkedin");
    assert.equal(isSupported, false, "Disclaimers mentioning search must not trigger false positive");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("platformSupported returns true only when the subcommand help genuinely succeeds", async () => {
  const { platformSupported } = await import("../src/socai.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-pos-help-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "instagram" && args[1] === "search" && args[2] === "--help") {
  console.log("Usage: socai instagram search <query>");
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const isSupported = await platformSupported(mock, "instagram");
    assert.equal(isSupported, true, "Subcommand search --help exit 0 must report platform supported");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actionCapabilities and platformSupported agree when platform help mentions search but subcommand fails", async () => {
  const { actionCapabilities, platformSupported } = await import("../src/socai.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-agree-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "linkedin" && args[1] === "--help") {
  console.log("linkedin search is unavailable in this build\\nCommands: profile company");
} else if (args[0] === "linkedin" && args[1] === "search" && args[2] === "--help") {
  console.error("unknown command: search");
  process.exitCode = 1;
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const isSupported = await platformSupported(mock, "linkedin");
    assert.equal(isSupported, false);

    const env = { ...process.env, SOCAI_BIN: mock };
    const commandsWithoutCap = await actionCapabilities({ env, platform: "linkedin" });
    assert.deepEqual(commandsWithoutCap, ["profile", "company"], "Must not include search when subcommand probe fails");

    const commandsWithCap = await actionCapabilities({ env, platform: "linkedin", capabilities: { linkedin: false } });
    assert.deepEqual(commandsWithCap, ["profile", "company"], "Must respect precomputed capabilities");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("probeSocai forwards cancellation signal promptly without waiting for timeout", async () => {
  const { probeSocai } = await import("../src/socai.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-abort-probe-"));
  const mock = path.join(directory, "socai-mock.mjs");
  await writeFile(
    mock,
    `#!/usr/bin/env node
setTimeout(() => {}, 30_000);
`,
    { mode: 0o755 },
  );
  await chmod(mock, 0o755);

  try {
    const controller = new AbortController();
    const env = { ...process.env, SOCAI_BIN: mock };
    const probePromise = probeSocai({}, env, controller.signal);
    // Abort shortly after spawning
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(probePromise, (err) => {
      return err.code === "SOCAI_ABORTED" || err.name === "AbortError";
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
