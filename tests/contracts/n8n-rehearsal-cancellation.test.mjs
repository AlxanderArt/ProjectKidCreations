import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { runAbortableChild } from "../../ops/n8n-disposable/process-control.mjs";

test("an already-aborted signal fails before spawn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-rehearsal-pre-abort-"));
  const marker = path.join(root, "spawned");
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  try {
    await assert.rejects(
      runAbortableChild(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker], { signal: controller.signal }),
      /aborted before spawn/,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("abort genuinely interrupts an active process group", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-rehearsal-in-flight-"));
  const ready = path.join(root, "ready");
  const terminated = path.join(root, "terminated");
  const controller = new AbortController();
  let childPid = null;
  try {
    const running = runAbortableChild(process.execPath, ["-e", [
      "const fs=require('node:fs');",
      "fs.writeFileSync(process.argv[1],String(process.pid));",
      "process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],'terminated');process.exit(42);});",
      "setInterval(()=>{},1000);",
    ].join(""), ready, terminated], {
      signal: controller.signal,
      timeoutMs: 10_000,
      onSpawn(child) { childPid = child.pid; },
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true, "child never reached its in-flight state");
    controller.abort(new Error("test in-flight abort"));
    await assert.rejects(running, /aborted in flight/);
    assert.equal(fs.readFileSync(terminated, "utf8"), "terminated");
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an abort stays pending while a SIGTERM-resistant child is alive and settles after SIGKILL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-rehearsal-forced-kill-"));
  const ready = path.join(root, "ready");
  const termSeen = path.join(root, "term-seen");
  const controller = new AbortController();
  let childPid = null;
  let settled = false;
  try {
    const running = runAbortableChild(process.execPath, ["-e", [
      "const fs=require('node:fs');",
      "fs.writeFileSync(process.argv[1],String(process.pid));",
      "process.on('SIGTERM',()=>fs.writeFileSync(process.argv[2],'ignored'));",
      "setInterval(()=>{},1000);",
    ].join(""), ready, termSeen], {
      signal: controller.signal,
      timeoutMs: 10_000,
      killGraceMs: 250,
      terminationWaitMs: 2_000,
      onSpawn(child) { childPid = child.pid; },
    });
    running.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true, "child never reached its in-flight state");

    controller.abort(new Error("force termination test"));
    for (let attempt = 0; attempt < 100 && !fs.existsSync(termSeen); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fs.readFileSync(termSeen, "utf8"), "ignored");
    assert.doesNotThrow(() => process.kill(childPid, 0), "child must still be alive after ignoring SIGTERM");
    assert.equal(settled, false, "promise settled before the live child was forcibly terminated");

    await assert.rejects(running, /aborted in flight/);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally {
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeout rejection is withheld until forced child termination is confirmed", async () => {
  let childPid = null;
  const running = runAbortableChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 75,
    terminationWaitMs: 2_000,
    onSpawn(child) { childPid = child.pid; },
  });
  await assert.rejects(running, /timed out/);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test("output overflow kills and reaps the process group before rejecting and cleans active tracking", async () => {
  const active = new Set();
  let childPid = null;
  const running = runAbortableChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"], {
    maxOutput: 128,
    timeoutMs: 10_000,
    terminationWaitMs: 2_000,
    active,
    onSpawn(child) { childPid = child.pid; },
  });
  await assert.rejects(running, /output bound exceeded/);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  assert.equal(active.size, 0);
});

test("maxOutput is an aggregate stdout plus stderr byte bound", async () => {
  let childPid = null;
  const running = runAbortableChild(process.execPath, ["-e", "process.stdout.write('o'.repeat(100));process.stderr.write('e'.repeat(100));setInterval(()=>{},1000)"], {
    maxOutput: 128,
    timeoutMs: 250,
    terminationWaitMs: 2_000,
    onSpawn(child) { childPid = child.pid; },
  });
  await assert.rejects(running, /output bound exceeded/);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test("successful parent close rejects and reaps a surviving process-group descendant", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkc-rehearsal-descendant-"));
  const descendantFile = path.join(root, "descendant");
  let parentPid = null;
  let descendantPid = null;
  try {
    const running = runAbortableChild(process.execPath, ["-e", [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "child.unref();",
      "fs.writeFileSync(process.argv[1],String(child.pid));",
    ].join(""), descendantFile], {
      timeoutMs: 10_000,
      terminationWaitMs: 2_000,
      onSpawn(child) { parentPid = child.pid; },
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(descendantFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    descendantPid = Number(fs.readFileSync(descendantFile, "utf8"));
    await assert.rejects(running, /process group survived parent close/);
    assert.throws(() => process.kill(-parentPid, 0), /ESRCH/);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    if (parentPid) { try { process.kill(-parentPid, "SIGKILL"); } catch {} }
    if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("EPERM signaling keeps the promise pending and child actively tracked until the group is dead", async () => {
  const active = new Set();
  let permitSignal = false;
  let childPid = null;
  let settled = false;
  const signalGroup = (child, signal) => {
    if (!permitSignal) { const error = new Error("simulated EPERM"); error.code = "EPERM"; throw error; }
    process.kill(-child.pid, signal);
  };
  const running = runAbortableChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 30,
    killGraceMs: 20,
    terminationWaitMs: 50,
    active,
    signalGroup,
    onSpawn(child) { childPid = child.pid; },
  });
  running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(settled, false);
    assert.equal(active.size, 1);
    assert.doesNotThrow(() => process.kill(-childPid, 0));
    permitSignal = true;
    await assert.rejects(running, /timed out/);
    assert.equal(active.size, 0);
    assert.throws(() => process.kill(-childPid, 0), /ESRCH/);
  } finally {
    permitSignal = true;
    if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch {} }
  }
});

test("onSpawn failure does not settle while its live group cannot be signaled", async () => {
  const active = new Set();
  let permitSignal = false;
  let childPid = null;
  let settled = false;
  const running = runAbortableChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 10_000,
    killGraceMs: 20,
    terminationWaitMs: 50,
    active,
    signalGroup(child, signal) {
      if (!permitSignal) { const error = new Error("simulated EPERM"); error.code = "EPERM"; throw error; }
      process.kill(-child.pid, signal);
    },
    onSpawn(child) { childPid = child.pid; throw new Error("onSpawn failed"); },
  });
  running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);
    assert.equal(active.size, 1);
    permitSignal = true;
    await assert.rejects(running, /onSpawn failed/);
    assert.equal(active.size, 0);
  } finally {
    permitSignal = true;
    if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch {} }
  }
});

test("child error does not settle before its live process group is terminated", async () => {
  const active = new Set();
  let childPid = null;
  const spawnChild = (...args) => {
    const child = spawn(...args);
    setImmediate(() => child.emit("error", new Error("synthetic child error")));
    return child;
  };
  const running = runAbortableChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 250,
    terminationWaitMs: 2_000,
    active,
    spawnChild,
    onSpawn(child) { childPid = child.pid; },
  });
  try {
    await assert.rejects(running, /synthetic child error/);
    assert.equal(active.size, 0);
    assert.throws(() => process.kill(-childPid, 0), /ESRCH/);
  } finally {
    if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch {} }
  }
});