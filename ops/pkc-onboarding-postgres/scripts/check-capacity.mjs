#!/usr/bin/env node
import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { fileURLToPath } from "node:url";

function finitePositive(value) { return Number.isFinite(value) && value > 0; }
function invariant(condition) { if (!condition) throw new Error("capacity_gate_failed"); }

export function collectHostMetrics(filesystem = "/") {
  const stat = statfsSync(filesystem, { bigint: true });
  const blockSize = stat.bsize;
  const capacityBytes = Number(stat.blocks * blockSize);
  const availableBytes = Number(stat.bavail * blockSize);
  const inodeCapacity = Number(stat.files);
  const inodeAvailable = Number(stat.ffree);
  invariant(Number.isSafeInteger(capacityBytes) && Number.isSafeInteger(availableBytes));
  invariant(Number.isSafeInteger(inodeCapacity) && Number.isSafeInteger(inodeAvailable));
  return Object.freeze({
    cpu: { availableCores: availableParallelism(), oneMinuteLoad: loadavg()[0] },
    memory: { availableMiB: freemem() / 1024 / 1024 },
    disk: { capacityBytes, availableBytes, inodeCapacity, inodeAvailable },
  });
}

export function evaluateCapacity(input, metrics) {
  invariant(input && input.schema_version === 2 && metrics);
  const expectedKeys = ["cpu","disk","memory","schema_version"];
  invariant(JSON.stringify(Object.keys(input).sort()) === JSON.stringify(expectedKeys));
  const { cpu, memory, disk } = input;
  invariant(JSON.stringify(Object.keys(cpu).sort()) === JSON.stringify(["requested_cores","reserve_cores"]));
  invariant(JSON.stringify(Object.keys(memory).sort()) === JSON.stringify(["requested_mib","reserve_mib"]));
  invariant(JSON.stringify(Object.keys(disk).sort()) === JSON.stringify(["inode_reserve","requested_mib","reserve_mib"]));
  for (const value of [cpu.requested_cores,cpu.reserve_cores,memory.requested_mib,memory.reserve_mib,disk.requested_mib,disk.reserve_mib,disk.inode_reserve]) invariant(finitePositive(value));
  invariant(metrics.cpu.availableCores > 0 && metrics.cpu.oneMinuteLoad >= 0);
  invariant(cpu.requested_cores + cpu.reserve_cores <= metrics.cpu.availableCores);
  invariant(metrics.memory.availableMiB >= memory.requested_mib + memory.reserve_mib);
  const usedPercent = ((metrics.disk.capacityBytes - metrics.disk.availableBytes) / metrics.disk.capacityBytes) * 100;
  const inodeUsedPercent = ((metrics.disk.inodeCapacity - metrics.disk.inodeAvailable) / metrics.disk.inodeCapacity) * 100;
  const projectedBytes = metrics.disk.capacityBytes - metrics.disk.availableBytes
    + ((disk.requested_mib + disk.reserve_mib) * 1024 * 1024);
  const projectedUsedPercent = (projectedBytes / metrics.disk.capacityBytes) * 100;
  invariant(usedPercent < 80 && inodeUsedPercent < 80);
  invariant(projectedUsedPercent <= 80);
  invariant(metrics.disk.availableBytes / 1024 / 1024 >= disk.requested_mib + disk.reserve_mib);
  invariant(metrics.disk.inodeAvailable >= disk.inode_reserve);
  return Object.freeze({ ready: true, usedPercent, projectedUsedPercent, inodeUsedPercent, oneMinuteLoad: metrics.cpu.oneMinuteLoad });
}

function main() {
  const [inputPath, filesystem = "/"] = process.argv.slice(2);
  invariant(typeof inputPath === "string" && inputPath.startsWith("/"));
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const result = evaluateCapacity(input, collectHostMetrics(filesystem));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch { process.stderr.write("capacity_gate_failed\n"); process.exitCode = 1; }
}
