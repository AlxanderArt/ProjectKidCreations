import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.mjs";

const PURPOSES = ["handoff", "encryption", "finalize", "recovery"];
const KID_PREFIX = { handoff: "handoff", encryption: "encryption", finalize: "finalize", recovery: "recovery-pepper" };
const PROD_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;

function requireLocalApproval({ directory, version, executeLocal, targetKind, typedApproval }, action) {
  if (executeLocal !== true || targetKind !== "disposable-local") throw new Error(`${action} requires explicit local execution and exact non-production target assertion`);
  const expected = action === "generation" ? "APPROVE LOCAL KEY GENERATION" : "APPROVE LOCAL KEY CLEANUP";
  if (typedApproval !== expected) throw new Error(`${action} requires exact typed local approval`);
  if (typeof directory !== "string" || directory.length === 0 || directory.length > 1024 || !Number.isSafeInteger(version) || version < 1) throw new Error("bounded directory and positive integer version required");
  const segments = resolve(directory).split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => PROD_LIKE.test(segment)) || PROD_LIKE.test(basename(directory))) throw new Error("production-like key target is forbidden; no production cleanup path exists");
}

function validateMaterial(material) {
  const values = PURPOSES.map((purpose) => material[purpose]);
  for (const value of values) if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("each key must be exactly 32 bytes");
  if (new Set(values.map((value) => value.toString("base64"))).size !== values.length) throw new Error("duplicate key bytes rejected");
}

function markerBytes(directory, version) {
  return canonicalJson({ schemaVersion: 1, operation: "local-key-generation", directory, version });
}

export async function createKeyFiles({ directory, version, at, material = Object.fromEntries(PURPOSES.map((p) => [p, randomBytes(32)])), executeLocal, targetKind, typedApproval }) {
  requireLocalApproval({ directory, version, executeLocal, targetKind, typedApproval }, "generation");
  if (!at || Number.isNaN(Date.parse(at))) throw new Error("valid caller-supplied timestamp required");
  validateMaterial(material);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink()) throw new Error("key ceremony directory symlink rejected");
  if (!directoryStat.isDirectory()) throw new Error("key ceremony path is not a directory");
  const ownedDirectory = await realpath(directory);
  const marker = join(ownedDirectory, `.pkc-key-ceremony-v${version}.incomplete`);
  await writeFile(marker, markerBytes(ownedDirectory, version), { mode: 0o600, flag: "wx" });
  const created = [];
  try {
    for (const purpose of PURPOSES) {
      const path = join(ownedDirectory, `${KID_PREFIX[purpose]}-v${version}.key`);
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(material[purpose]); } finally { await handle.close(); }
      await stat(path).then((s) => { if ((s.mode & 0o777) !== 0o600) throw new Error("key file mode is not 0600"); });
      created.push(path);
    }
    await rm(marker);
    return { schemaVersion: 1, createdAt: at, version, locationKind: "caller-specified-mode-0600-file", targetKind, keys: PURPOSES.map((purpose, index) => ({ purpose, kid: `${KID_PREFIX[purpose]}-v${version}`, byteLength: 32, path: created[index] })) };
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    await rm(marker, { force: true });
    throw error;
  }
}

export async function cleanupInterruptedKeyRun({ directory, version, executeLocal, targetKind, typedApproval }) {
  requireLocalApproval({ directory, version, executeLocal, targetKind, typedApproval }, "cleanup");
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("cleanup directory symlink or type rejected");
  const ownedDirectory = await realpath(directory);
  const marker = join(ownedDirectory, `.pkc-key-ceremony-v${version}.incomplete`);
  let markerStat;
  try { markerStat = await lstat(marker); }
  catch { throw new Error("exact interrupted-run ownership marker is missing"); }
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || (markerStat.mode & 0o777) !== 0o600 || (await readFile(marker, "utf8")) !== markerBytes(ownedDirectory, version)) throw new Error("interrupted-run ownership marker is invalid");
  for (const purpose of PURPOSES) await rm(join(ownedDirectory, `${KID_PREFIX[purpose]}-v${version}.key`), { force: true });
  await rm(marker);
  return { cleaned: true, scope: { directory: ownedDirectory, version, targetKind } };
}

export function probeHistoricalKeyring(keyring, requiredKids) {
  const readable = requiredKids.filter((kid) => keyring[kid] === true).sort();
  const missing = requiredKids.filter((kid) => keyring[kid] !== true).sort();
  return { ok: missing.length === 0, readable, missing };
}

export function planEncryptionRotation({ from, to, dependentRows }) {
  if (from === to) throw new Error("rotation versions must differ");
  return { from, to, dependentRows, writeVersion: to, readVersions: [from, to], transaction: "row-lock-and-reencrypt", removeOldKeyAllowed: dependentRows === 0 };
}

export { PURPOSES as KEY_PURPOSES };
