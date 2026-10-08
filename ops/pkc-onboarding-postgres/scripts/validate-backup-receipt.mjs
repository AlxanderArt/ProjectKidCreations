import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { validateClusterReceiptBytes } from "./validate-cluster-receipt.mjs";

function fail() { throw new Error("backup_receipt_invalid"); }
function boundedDescriptor(fd, limit) {
  if (!Number.isSafeInteger(fd) || fd < 0) fail();
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) fail();
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) fail();
    offset += count;
  }
  const after = fstatSync(fd);
  if (["dev", "ino", "size", "mode", "uid", "nlink", "mtimeMs", "ctimeMs"].some((key) => after[key] !== stat[key])) fail();
  return bytes;
}
function boundedPath(path, limit) {
  if (typeof path !== "string" || !path.startsWith("/")) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return boundedDescriptor(fd, limit); } finally { closeSync(fd); }
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function validateBackupReceiptBytes({ artifactName, artifactSha256, checksumBytes, receiptBytes, sourceReceiptBytes }) {
  if (typeof artifactName !== "string" || basename(artifactName) !== artifactName || !/^[a-zA-Z0-9._-]+$/.test(artifactName)) fail();
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) fail();
  if (![checksumBytes, receiptBytes, sourceReceiptBytes].every(Buffer.isBuffer)) fail();
  if (checksumBytes.length < 1 || checksumBytes.length > 256 || receiptBytes.length < 1 || receiptBytes.length > 4096 || sourceReceiptBytes.length < 1 || sourceReceiptBytes.length > 16384) fail();
  if (checksumBytes.toString("utf8") !== `${artifactSha256}  ${artifactName}\n`) fail();
  validateClusterReceiptBytes(sourceReceiptBytes);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const keys = Object.keys(receipt).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["artifact","artifactSha256","createdAt","schema","sourceReceiptSha256"])) fail();
  if (receipt.schema !== "pkc-encrypted-backup-receipt-v1" || receipt.artifact !== artifactName || receipt.artifactSha256 !== artifactSha256) fail();
  if (receipt.sourceReceiptSha256 !== digest(sourceReceiptBytes)) fail();
  if (!/^\d{8}T\d{6}Z$/.test(receipt.createdAt)) fail();
  return receipt;
}

function parseFdMode(args) {
  const expected = ["--artifact-fd", "--artifact-name", "--checksum-fd", "--backup-receipt-fd", "--source-receipt-fd"];
  if (args.length !== expected.length * 2) fail();
  const result = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (args[index * 2] !== expected[index]) fail();
    result[expected[index]] = args[index * 2 + 1];
  }
  if (!/^[0-9]+$/.test(result["--artifact-fd"]) || !/^[0-9]+$/.test(result["--checksum-fd"]) || !/^[0-9]+$/.test(result["--backup-receipt-fd"]) || !/^[0-9]+$/.test(result["--source-receipt-fd"])) fail();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let artifactName, artifact, checksumBytes, receiptBytes, sourceReceiptBytes;
    if (args[0] === "--artifact-fd") {
      const parsed = parseFdMode(args);
      artifactName = parsed["--artifact-name"];
      artifact = boundedDescriptor(Number(parsed["--artifact-fd"]), 1024 * 1024 * 1024 * 64);
      checksumBytes = boundedDescriptor(Number(parsed["--checksum-fd"]), 256);
      receiptBytes = boundedDescriptor(Number(parsed["--backup-receipt-fd"]), 4096);
      sourceReceiptBytes = boundedDescriptor(Number(parsed["--source-receipt-fd"]), 16384);
    } else {
      const [artifactPath, checksumPath, receiptPath, sourceReceiptPath] = args;
      if (args.length !== 4) fail();
      artifactName = basename(artifactPath);
      artifact = boundedPath(artifactPath, 1024 * 1024 * 1024 * 64);
      checksumBytes = boundedPath(checksumPath, 256);
      receiptBytes = boundedPath(receiptPath, 4096);
      sourceReceiptBytes = boundedPath(sourceReceiptPath, 16384);
    }
    validateBackupReceiptBytes({ artifactName, artifactSha256: digest(artifact), checksumBytes, receiptBytes, sourceReceiptBytes });
    process.stdout.write("backup_receipt_valid=true\n");
  } catch {
    process.stderr.write("backup_receipt_invalid\n");
    process.exitCode = 1;
  }
}
