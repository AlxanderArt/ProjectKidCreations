#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { validateBackupReceiptBytes } from "./validate-backup-receipt.mjs";

const fail = () => { throw new Error("validated_decrypt_rejected"); };
const fingerprint = (stat) => [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(":");
function openAuthority(path, maximum) {
  if (typeof path !== "string" || !path.startsWith("/")) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) fail();
    return { fd, stat, fingerprint: fingerprint(stat) };
  } catch (error) { closeSync(fd); throw error; }
}
function readAuthority(authority) {
  const bytes = Buffer.alloc(authority.stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(authority.fd, bytes, offset, bytes.length - offset, offset);
    if (!count) fail();
    offset += count;
  }
  return bytes;
}
function hashAuthority(authority) {
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < authority.stat.size) {
    const count = readSync(authority.fd, buffer, 0, Math.min(buffer.length, authority.stat.size - position), position);
    if (!count) fail();
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}
function revalidate(authority, expectedHash) {
  if (fingerprint(fstatSync(authority.fd)) !== authority.fingerprint || hashAuthority(authority) !== expectedHash) fail();
}
function parse(args) {
  const mode = args.shift();
  const common = ["--artifact", "--checksum", "--backup-receipt", "--source-receipt"];
  const extra = mode === "--validate-only" ? [] : mode === "--decrypt-stdout" ? ["--identity-file", "--expected-set-proof"] : fail();
  const keys = [...common, ...extra];
  if (args.length !== keys.length * 2) fail();
  const values = new Map();
  for (let index = 0; index < keys.length; index += 1) {
    if (args[index * 2] !== keys[index] || values.has(keys[index])) fail();
    values.set(keys[index], args[index * 2 + 1]);
  }
  return { mode, values };
}
function setProof(artifactName, hashes) {
  return createHash("sha256").update(JSON.stringify({ artifactName, ...hashes })).digest("hex");
}

const opened = [];
try {
  const { mode, values } = parse(process.argv.slice(2));
  const artifactPath = values.get("--artifact");
  const artifact = openAuthority(artifactPath, 64 * 1024 ** 3);
  const checksum = openAuthority(values.get("--checksum"), 256);
  const receipt = openAuthority(values.get("--backup-receipt"), 4096);
  const source = openAuthority(values.get("--source-receipt"), 16384);
  opened.push(artifact, checksum, receipt, source);
  const hashes = {
    artifactSha256: hashAuthority(artifact), checksumSha256: hashAuthority(checksum),
    backupReceiptSha256: hashAuthority(receipt), sourceReceiptSha256: hashAuthority(source),
  };
  const sourceBytes = readAuthority(source);
  validateBackupReceiptBytes({
    artifactName: basename(artifactPath), artifactSha256: hashes.artifactSha256,
    checksumBytes: readAuthority(checksum), receiptBytes: readAuthority(receipt), sourceReceiptBytes: sourceBytes,
  });
  const proof = setProof(basename(artifactPath), hashes);
  if (mode === "--validate-only") {
    for (const [authority, hash] of [[artifact, hashes.artifactSha256], [checksum, hashes.checksumSha256], [receipt, hashes.backupReceiptSha256], [source, hashes.sourceReceiptSha256]]) revalidate(authority, hash);
    process.stdout.write(`set_proof=${proof}\nsource_receipt_base64=${sourceBytes.toString("base64")}\n`);
  } else {
    if (!/^[a-f0-9]{64}$/.test(values.get("--expected-set-proof")) || values.get("--expected-set-proof") !== proof) fail();
    const identity = openAuthority(values.get("--identity-file"), 64 * 1024);
    opened.push(identity);
    const identityHash = hashAuthority(identity);
    const result = spawnSync("age", ["--decrypt", "--identity", "/proc/self/fd/3", "-"], {
      stdio: [artifact.fd, "inherit", "pipe", identity.fd], timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.signal || result.error) fail();
    for (const [authority, hash] of [[artifact, hashes.artifactSha256], [checksum, hashes.checksumSha256], [receipt, hashes.backupReceiptSha256], [source, hashes.sourceReceiptSha256], [identity, identityHash]]) revalidate(authority, hash);
  }
} catch {
  process.stderr.write("validated_decrypt_rejected\n");
  process.exitCode = 1;
} finally {
  for (const authority of opened.reverse()) { try { closeSync(authority.fd); } catch {} }
}
