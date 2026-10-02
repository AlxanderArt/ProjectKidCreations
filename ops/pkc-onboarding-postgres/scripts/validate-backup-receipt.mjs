import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, lstat } from "node:fs/promises";

function fail() { throw new Error("backup_receipt_invalid"); }
async function boundedFile(path, limit) {
  const stat = await lstat(path).catch(fail);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) fail();
  return readFile(path);
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const [artifactPath, checksumPath, receiptPath, sourceReceiptPath] = process.argv.slice(2);
try {
  if (![artifactPath, checksumPath, receiptPath, sourceReceiptPath].every((value) => typeof value === "string" && value.startsWith("/"))) fail();
  const artifact = await boundedFile(artifactPath, 1024 * 1024 * 1024 * 64);
  const checksum = (await boundedFile(checksumPath, 256)).toString("utf8");
  const receiptBytes = await boundedFile(receiptPath, 4096);
  const sourceReceipt = await boundedFile(sourceReceiptPath, 16384);
  const artifactSha256 = digest(artifact);
  if (checksum !== `${artifactSha256}  ${basename(artifactPath)}\n`) fail();
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const keys = Object.keys(receipt).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["artifact","artifactSha256","createdAt","schema","sourceReceiptSha256"])) fail();
  if (receipt.schema !== "pkc-encrypted-backup-receipt-v1" || receipt.artifact !== basename(artifactPath) || receipt.artifactSha256 !== artifactSha256) fail();
  if (receipt.sourceReceiptSha256 !== digest(sourceReceipt)) fail();
  if (!/^\d{8}T\d{6}Z$/.test(receipt.createdAt)) fail();
  process.stdout.write("backup_receipt_valid=true\n");
} catch {
  process.stderr.write("backup_receipt_invalid\n");
  process.exitCode = 1;
}
