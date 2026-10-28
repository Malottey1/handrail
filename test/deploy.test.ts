import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPolicyFile, seedPolicyFile } from "../src/policy/load.js";
import { storageStatus } from "../src/storage.js";

const DEFAULT_POLICY = "policy.json"; // the committed default, as src/index.ts uses it

describe("policy seeding on boot", () => {
  it("copies the committed default policy when the configured file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "handrail-seed-"));
    const path = join(dir, "disk", "policy.json"); // a fresh, empty disk: not even the folder exists
    assert.equal(seedPolicyFile(path, DEFAULT_POLICY), true);
    assert.equal(readFileSync(path, "utf8"), readFileSync(DEFAULT_POLICY, "utf8"));
    assert.ok(loadPolicyFile(path).rules.length > 0);
  });

  it("never overwrites an existing policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "handrail-seed-"));
    const path = join(dir, "policy.json");
    const edited = JSON.stringify({ version: 1, defaults: { read: "allow", write: "allow", money: "require_approval", unknown: "require_approval" }, rules: [] });
    writeFileSync(path, edited);
    assert.equal(seedPolicyFile(path, DEFAULT_POLICY), false);
    assert.equal(readFileSync(path, "utf8"), edited);
  });

  it("does nothing when the configured file is the default itself", () => {
    assert.equal(seedPolicyFile(DEFAULT_POLICY, DEFAULT_POLICY), false);
  });

  it("refuses to seed from an invalid default", () => {
    const dir = mkdtempSync(join(tmpdir(), "handrail-seed-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.throws(() => seedPolicyFile(join(dir, "policy.json"), bad));
  });
});

describe("storage status", () => {
  const dir = mkdtempSync(join(tmpdir(), "handrail-storage-"));
  const db = join(dir, "handrail.db");
  const policy = join(dir, "policy.json");

  it("is local off Render", () => {
    assert.equal(storageStatus(db, policy, {}).mode, "local");
  });

  it("is temporary on Render when the files share the app's filesystem", () => {
    const s = storageStatus(db, policy, { RENDER: "true" }, dir);
    assert.equal(s.mode, "temporary");
    assert.equal(s.db.persistent, false);
    assert.equal(s.policy.persistent, false);
  });

  it("is persistent on Render when the files are on another filesystem (a mounted disk)", () => {
    // /dev is its own filesystem on macOS and Linux, standing in for the app's directory.
    const s = storageStatus(db, policy, { RENDER_SERVICE_ID: "srv-123" }, "/dev");
    assert.equal(s.mode, "persistent");
  });
});
