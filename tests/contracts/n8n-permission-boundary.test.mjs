import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import test from "node:test";

const deniedCanary = process.env.PKC_N8N_DENIED_CANARY;
if (!deniedCanary) throw new Error("PKC_N8N_DENIED_CANARY is required by the permission-isolated synthetic gate");
const denied = (error) => error?.code === "ERR_ACCESS_DENIED" || /access denied|permission/i.test(String(error?.message || error));

test("permission boundary denies synchronous filesystem reads of the test-only protected analogue", () => {
  assert.throws(() => fs.readFileSync(deniedCanary), denied);
});

test("permission boundary denies callback filesystem reads of the test-only protected analogue", async () => {
  await new Promise((resolve, reject) => fs.readFile(deniedCanary, (error) => {
    try { assert.ok(denied(error), String(error)); resolve(); } catch (assertionError) { reject(assertionError); }
  }));
});

test("permission boundary denies fs/promises reads of the test-only protected analogue", async () => {
  await assert.rejects(fsp.readFile(deniedCanary), denied);
});

test("permission boundary denies stream reads of the test-only protected analogue", async () => {
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(deniedCanary);
    stream.once("data", () => reject(new Error("denied canary stream produced data")));
    stream.once("error", (error) => {
      try { assert.ok(denied(error), String(error)); resolve(); } catch (assertionError) { reject(assertionError); }
    });
  });
});

test("permission boundary denies child-process escape", () => {
  assert.throws(() => childProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"]), denied);
});
