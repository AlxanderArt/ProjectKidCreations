#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { constants, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateBackupReceiptBytes } from "./validate-backup-receipt.mjs";
import { validateClusterReceiptBytes } from "./validate-cluster-receipt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE_HELPER = resolve(HERE, "publish-a1of1-remote.py");
const REMOTE_ALIAS = "a1of1";
const REMOTE_OWNER = "aiel";
const REMOTE_ROOT = "/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres";
const SSH_OPTIONS = [
  "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
  "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "ClearAllForwardings=yes",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
  "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"
];
const ARTIFACT_RE = /^pkc-onboarding-[0-9]{8}T[0-9]{6}Z\.dump\.age$/;
const fail = () => { throw new Error("a1of1_publish_rejected"); };
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(["--artifact", "--checksum", "--backup-receipt", "--source-receipt"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || result[key]) fail();
    result[key] = value;
  }
  if (Object.keys(result).length !== 4) fail();
  return result;
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.nlink, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}

async function openAuthority(path, maximum, expectedMode = 0o600n) {
  if (!isAbsolute(path)) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o777n) !== expectedMode || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximum)) fail();
    return { handle, stat, fingerprint: fingerprint(stat) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readSmall(authority, maximum) {
  const size = Number(authority.stat.size);
  if (size > maximum) fail();
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await authority.handle.read(buffer, offset, size - offset, offset);
    if (!bytesRead) fail();
    offset += bytesRead;
  }
  return buffer;
}

async function hashAuthority(authority) {
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  const size = Number(authority.stat.size);
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await authority.handle.read(buffer, 0, length, position);
    if (!bytesRead) fail();
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) fail();
  return digest.digest("hex");
}

async function revalidate(authority, expectedSha) {
  const current = await authority.handle.stat({ bigint: true });
  if (fingerprint(current) !== authority.fingerprint || await hashAuthority(authority) !== expectedSha) fail();
}

function runRemote(sourceBase64, mode, args, inputFd = null) {
  const bootstrap = `import base64;exec(compile(base64.b64decode("${sourceBase64}"),"pkc-a1of1-remote.py","exec"))`;
  const command = ["/usr/bin/python3", "-c", bootstrap, mode, REMOTE_ROOT, REMOTE_OWNER, ...args].map(shellQuote).join(" ");
  const result = spawnSync("ssh", [...SSH_OPTIONS, REMOTE_ALIAS, command], {
    encoding: "utf8",
    stdio: [inputFd === null ? "ignore" : inputFd, "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.signal || result.error) fail();
  return result.stdout.trim();
}

const authorities = [];
let stageActive = false;
let remoteSource = "";
let identityArgs = [];
let layoutProofs = [];
function cleanupRemote() {
  if (!stageActive || !remoteSource || identityArgs.length !== 3 || layoutProofs.length !== 2) return true;
  try {
    const output = runRemote(remoteSource, "cleanup", [...identityArgs, ...layoutProofs]);
    return output === "a1of1_staging_removed=true";
  } catch {
    return false;
  }
}

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signal, () => {
    const clean = cleanupRemote();
    process.exit(clean ? status : 1);
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args["--artifact"];
  const checksumPath = args["--checksum"];
  const receiptPath = args["--backup-receipt"];
  const sourceReceiptPath = args["--source-receipt"];
  const artifactName = basename(artifactPath);
  if (!ARTIFACT_RE.test(artifactName) || basename(checksumPath) !== `${artifactName}.sha256` || basename(receiptPath) !== `${artifactName}.receipt.json`) fail();

  const artifact = await openAuthority(artifactPath, 64 * 1024 ** 3);
  const checksum = await openAuthority(checksumPath, 256);
  const receipt = await openAuthority(receiptPath, 4096);
  const sourceReceipt = await openAuthority(sourceReceiptPath, 16384);
  authorities.push(artifact, checksum, receipt, sourceReceipt);

  const artifactSha = await hashAuthority(artifact);
  const checksumSha = await hashAuthority(checksum);
  const receiptSha = await hashAuthority(receipt);
  const sourceReceiptSha = await hashAuthority(sourceReceipt);
  const checksumBytes = await readSmall(checksum, 256);
  const receiptBytes = await readSmall(receipt, 4096);
  const sourceReceiptBytes = await readSmall(sourceReceipt, 16384);
  validateClusterReceiptBytes(sourceReceiptBytes);
  validateBackupReceiptBytes({ artifactName, artifactSha256: artifactSha, checksumBytes, receiptBytes, sourceReceiptBytes });

  const remoteHelper = await openAuthority(REMOTE_HELPER, 256 * 1024, 0o755n);
  authorities.push(remoteHelper);
  remoteSource = (await readSmall(remoteHelper, 256 * 1024)).toString("base64");
  const remoteHelperSha = await hashAuthority(remoteHelper);
  const nonce = randomBytes(16).toString("hex");
  identityArgs = [artifactName, artifactSha, nonce];
  const preflight = runRemote(remoteSource, "preflight", [...identityArgs, String(artifact.stat.size)]);
  const preflightLines = preflight.split("\n");
  if (preflightLines.length !== 3 || preflightLines[0] !== "a1of1_staging_ready=true") fail();
  const layoutMatch = /^layout_proof=([a-f0-9]{64})$/.exec(preflightLines[1]);
  const stageMatch = /^stage_proof=([a-f0-9]{64})$/.exec(preflightLines[2]);
  if (!layoutMatch || !stageMatch) fail();
  layoutProofs = [layoutMatch[1], stageMatch[1]];
  stageActive = true;

  for (const [name, authority, sha] of [["artifact", artifact, artifactSha], ["checksum", checksum, checksumSha], ["backup-receipt", receipt, receiptSha], ["source-receipt", sourceReceipt, sourceReceiptSha]]) {
    const output = runRemote(remoteSource, "receive", [...identityArgs, ...layoutProofs, name, sha], authority.handle.fd);
    if (output !== `a1of1_received=${name}`) fail();
    await revalidate(authority, sha);
  }
  await revalidate(sourceReceipt, sourceReceiptSha);
  await revalidate(remoteHelper, remoteHelperSha);

  const result = runRemote(remoteSource, "finalize", [...identityArgs, ...layoutProofs, checksumSha, receiptSha, sourceReceiptSha]);
  await revalidate(remoteHelper, remoteHelperSha);
  const lines = new Set(result.split("\n"));
  if (!lines.has("a1of1_backup_published=true") || !lines.has(`artifact_sha256=${artifactSha}`)) fail();
  stageActive = false;
  process.stdout.write(`${result}\na1of1_destination=${REMOTE_ROOT}\n`);
} catch {
  const cleaned = cleanupRemote();
  process.stderr.write("a1of1_publish_rejected\n");
  process.exitCode = cleaned ? 1 : 2;
} finally {
  for (const authority of authorities.reverse()) {
    try { await authority.handle.close(); } catch {}
  }
}
