import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listRuns, markInterruptedRuns, readRun, saveRun } from "../src/runs.js";

test("startup recovery marks stale running checkpoints as interrupted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-runs-"));
  const env = { ...process.env, JEV_SOCIAL_HOME: directory };
  try {
    await saveRun({
      id: "stale-run",
      createdAt: "2026-09-22T00:00:00.000Z",
      status: "running",
      stopReason: "Research is still in progress.",
      result: { ok: false, items: [{ url: "https://example.com/post" }] },
      report: "# Captured evidence\n\nThe run is partial.",
    }, env);
    assert.equal(await markInterruptedRuns(env), 1);
    const recovered = await readRun("stale-run", env);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.result.ok, false);
    assert.match(recovered.stopReason, /process stopped/i);
    assert.equal(await markInterruptedRuns(env), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent checkpoints for one run remain valid JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-runs-"));
  const env = { ...process.env, JEV_SOCIAL_HOME: directory };
  try {
    await Promise.all(Array.from({ length: 20 }, (_, sequence) => saveRun({
      id: "shared-run",
      createdAt: "2026-09-22T00:00:00.000Z",
      status: "running",
      sequence,
      result: { items: Array.from({ length: sequence }, (__, index) => ({ id: index })) },
    }, env)));
    const recovered = await readRun("shared-run", env);
    assert.equal(recovered.sequence, 19);
    assert.equal(recovered.result.items.length, 19);
    assert.equal((await listRuns(env)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("saveRun rejects ids that could escape the runs directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-social-runs-"));
  const env = { ...process.env, JEV_SOCIAL_HOME: directory };
  try {
    await assert.rejects(saveRun({ id: "../outside", result: {} }, env), /invalid characters/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
