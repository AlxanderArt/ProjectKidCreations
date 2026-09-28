#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactPrivacyScan, compareSemanticReadback, serializeNineArtifacts } from "./n8n-workflow-as-code.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const PROTECTED_SOURCE_DIR = "/root/.hermes/protected/pkc-founder-mfa/source-workflows";
const PROTECTED_BASENAMES = new Set(["wfDsutVsW15DHGr3.json", "nvgxxBPinPmsEmZq.json", "uuNgivASLQZ08gX7.json", "GVVnbelFG97UjJDw.json", "W63ETZfmKVI7UDFW.json", "jb0I4CqlJuuG6fXs.json"]);
const LIMITS = Object.freeze({ depth: 80, nodes: 250000, aggregateString: 8_000_000, string: 1_000_000 });
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function parseBoundedJson(text, limits = LIMITS) {
  let i = 0; let nodes = 0; let strings = 0;
  const fail = (message) => { throw new Error(`invalid JSON at byte ${i}: ${message}`); };
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i += 1; };
  const count = (depth) => { if (++nodes > limits.nodes) fail("node bound exceeded"); if (depth > limits.depth) fail("depth bound exceeded"); };
  const string = () => {
    if (text[i] !== '"') fail("string required"); const start = i++;
    while (i < text.length) { const c = text[i++]; if (c === '"') break; if (c === "\\") { if (i >= text.length) fail("truncated escape"); const e = text[i++]; if (e === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) fail("invalid unicode escape"); i += 4; } else if (!'"\\/bfnrt'.includes(e)) fail("invalid escape"); } else if (c.charCodeAt(0) < 0x20) fail("control in string"); }
    if (text[i - 1] !== '"') fail("unterminated string"); const raw = text.slice(start, i); let value; try { value = JSON.parse(raw); } catch { fail("invalid string"); }
    for (let p = 0; p < value.length; p += 1) { const unit = value.charCodeAt(p); if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++p); if (!(next >= 0xdc00 && next <= 0xdfff)) fail("unpaired surrogate"); } else if (unit >= 0xdc00 && unit <= 0xdfff) fail("unpaired surrogate"); }
    strings += value.length; if (value.length > limits.string || strings > limits.aggregateString) fail("string bound exceeded"); return value;
  };
  const value = (depth = 0) => { count(depth); ws(); const c = text[i];
    if (c === '"') return string();
    if (c === "{") { i += 1; ws(); const out = {}; const keys = new Set(); if (text[i] === "}") { i += 1; return out; } while (true) { ws(); const key = string(); if (keys.has(key)) fail(`duplicate key ${JSON.stringify(key)}`); if (["__proto__", "prototype", "constructor"].includes(key)) fail("prototype key refused"); keys.add(key); ws(); if (text[i++] !== ":") fail("colon required"); Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); ws(); const sep = text[i++]; if (sep === "}") return out; if (sep !== ",") fail("comma required"); } }
    if (c === "[") { i += 1; ws(); const out = []; if (text[i] === "]") { i += 1; return out; } while (true) { out.push(value(depth + 1)); ws(); const sep = text[i++]; if (sep === "]") return out; if (sep !== ",") fail("comma required"); } }
    const rest = text.slice(i); for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) if (rest.startsWith(literal)) { i += literal.length; return parsed; }
    const match = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/); if (!match) fail("value required"); i += match[0].length; const number = Number(match[0]); if (!Number.isFinite(number)) fail("non-finite number"); return number;
  };
  const parsed = value(); ws(); if (i !== text.length) fail("trailing data"); return parsed;
}

export function readJsonDescriptorSafe(file, { protectedInput = false } = {}) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags); try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${path.basename(file)} must be a regular file`);
    if (protectedInput && Number(before.mode & 0o777n) !== 0o600) throw new Error(`${path.basename(file)} must be mode 0600`);
    if (before.size < 2n || before.size > BigInt(MAX_BYTES)) throw new Error(`${path.basename(file)} size outside bounds`);
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (read === 0) throw new Error(`${path.basename(file)} changed during read`); offset += read; }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(offset) !== after.size) throw new Error(`${path.basename(file)} identity changed during read`);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const parsed = parseBoundedJson(text);
    return { value: parsed, rawSha256: sha256(bytes), canonicalSha256: sha256(Buffer.from(canonical(parsed), "utf8")) };
  } finally { fs.closeSync(fd); }
}

const emitted = (value) => `${JSON.stringify(value, null, 2)}\n`;
function writeExclusive(file, value) { fs.writeFileSync(file, emitted(value), { encoding: "utf8", flag: "wx", mode: 0o600 }); }
function fail(message) { process.stderr.write(`n8n-workflows: ${message}\n`); process.exitCode = 1; }

export function serializeProtectedFiles(inputFiles, outputDir) {
  if (!Array.isArray(inputFiles) || inputFiles.length !== 6) throw new Error("exactly six protected snapshots required");
  if (fs.realpathSync(PROTECTED_SOURCE_DIR) !== PROTECTED_SOURCE_DIR) throw new Error("protected source directory ancestry drift");
  const resolved = inputFiles.map((file) => path.resolve(file));
  if (new Set(resolved).size !== 6 || resolved.some((file) => path.dirname(file) !== PROTECTED_SOURCE_DIR || !PROTECTED_BASENAMES.has(path.basename(file)) || fs.realpathSync(file) !== file)) throw new Error("release requires the exact six protected source paths");
  if (new Set(resolved.map((file) => path.basename(file))).size !== PROTECTED_BASENAMES.size) throw new Error("release protected source set is not closed");
  if (fs.existsSync(outputDir)) throw new Error("output directory must not already exist");
  const loaded = inputFiles.map((file) => readJsonDescriptorSafe(file, { protectedInput: true }));
  const rawDigests = Object.fromEntries(loaded.map((item) => [item.value.id, item.rawSha256]));
  const result = serializeNineArtifacts(loaded.map((item) => item.value), { sourceRawDigests: rawDigests });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  try {
    for (const item of result.artifacts) { const file = path.join(outputDir, `${item.role}.json`); writeExclusive(file, item.workflow); if (sha256(fs.readFileSync(file)) !== item.rawSha256) throw new Error(`${item.role}: emitted-byte hash readback mismatch`); }
    writeExclusive(path.join(outputDir, "manifest.json"), result.manifest);
  } catch (error) { fs.rmSync(outputDir, { recursive: true, force: true }); throw error; }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const [command, ...args] = process.argv.slice(2);
    if (command === "serialize") { const separator = args.indexOf("--out"); if (separator !== 6 || args.length !== 8) throw new Error("usage: serialize <six protected snapshots> --out <new-empty-dir>"); const outputDir = path.resolve(args[7]); const result = serializeProtectedFiles(args.slice(0, 6), outputDir); process.stdout.write(`${JSON.stringify({ ok: true, artifactCount: result.artifacts.length, outputDir })}\n`); }
    else if (command === "compare") { if (args.length !== 2) throw new Error("usage: compare <expected.json> <native-readback.json>"); const result = compareSemanticReadback(readJsonDescriptorSafe(args[0]).value, readJsonDescriptorSafe(args[1]).value); process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.equal) process.exitCode = 2; }
    else if (command === "privacy") { if (args.length < 1) throw new Error("usage: privacy <artifact.json> [...]"); const result = artifactPrivacyScan(args.map((file) => readJsonDescriptorSafe(file).value)); process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode = 2; }
    else throw new Error("commands: serialize | compare | privacy");
  } catch (error) { fail(error.message); }
}
