import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_PGPASS_BYTES = 8192;
const MAX_TLS_BYTES = 64 * 1024;

function fail() { throw new Error("pgpassfile_invalid"); }
function failTls() { throw new Error("pg_tls_authority_invalid"); }

function splitPgPassLine(line) {
  const fields = [""];
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      if (character !== ":" && character !== "\\") fail();
      fields[fields.length - 1] += character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === ":" && fields.length < 5) fields.push("");
    else fields[fields.length - 1] += character;
  }
  if (escaped || fields.length !== 5 || fields.some((field) => field.length === 0)) fail();
  return fields;
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.uid === after.uid && before.gid === after.gid && before.nlink === after.nlink
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function readAuthorityFile(file, maximumBytes, invalid) {
  if (typeof file !== "string" || !file.startsWith("/")) invalid();
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : before.uid;
    if (!before.isFile() || before.nlink !== 1n || before.uid !== expectedUid || (before.mode & 0o077n) !== 0n
        || before.size < 1n || before.size > BigInt(maximumBytes)) invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || BigInt(bytes.length) !== before.size || bytes.includes(0)) invalid();
    return bytes;
  } catch (error) {
    if (["pgpassfile_invalid", "pg_tls_authority_invalid"].includes(error?.message)) throw error;
    invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeUtf8(bytes, invalid) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
}

function assertPem(value, label) {
  const normalized = value.trim();
  const certificate = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/;
  const keyPemPattern = /^-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\n[A-Za-z0-9+/=\n]+\n-----END (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----$/;
  if (!(label === "key" ? keyPemPattern : certificate).test(normalized)) failTls();
  return `${normalized}\n`;
}

export async function loadPgClientAuthority({ connectionString, pgpassFile }) {
  if (typeof connectionString !== "string" || !connectionString) throw new TypeError("invalid_pg_connection_authority");
  let target;
  try { target = new URL(connectionString); } catch { throw new TypeError("invalid_pg_connection_authority"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !target.hostname || !target.username || !target.pathname || target.pathname === "/" || target.password) {
    throw new TypeError("invalid_pg_connection_authority");
  }
  const parameterNames = [...target.searchParams.keys()];
  const requiredParameters = ["sslmode", "sslrootcert", "sslcert", "sslkey"];
  const allowedParameters = new Set([...requiredParameters, "application_name"]);
  if (new Set(parameterNames).size !== parameterNames.length || parameterNames.some((name) => !allowedParameters.has(name))
      || requiredParameters.some((name) => !target.searchParams.has(name))
      || target.searchParams.get("sslmode") !== "verify-full") throw new TypeError("invalid_pg_connection_authority");

  const tlsPaths = {
    ca: target.searchParams.get("sslrootcert"),
    cert: target.searchParams.get("sslcert"),
    key: target.searchParams.get("sslkey"),
  };
  const tlsEntries = await Promise.all(Object.entries(tlsPaths).map(async ([label, file]) => [
    label,
    assertPem(decodeUtf8(await readAuthorityFile(file, MAX_TLS_BYTES, failTls), failTls), label),
  ]));
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) target.searchParams.delete(key);

  const pgpassBytes = await readAuthorityFile(pgpassFile, MAX_PGPASS_BYTES, fail);
  const text = decodeUtf8(pgpassBytes, fail);
  const expected = [target.hostname, target.port || "5432", decodeURIComponent(target.pathname.slice(1)), decodeURIComponent(target.username)];
  let matchingFields;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith("#")) continue;
    const fields = splitPgPassLine(line);
    if (fields.slice(0, 4).every((field, index) => field === "*" || field === expected[index])) { matchingFields = fields; break; }
  }
  if (!matchingFields) fail();
  const runtimeCredential = matchingFields[4];
  return Object.freeze({
    connectionString: target.toString(),
    password: runtimeCredential,
    ssl: Object.freeze({ rejectUnauthorized: true, servername: target.hostname, ...Object.fromEntries(tlsEntries) }),
  });
}
