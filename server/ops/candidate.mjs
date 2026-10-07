import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "./canonical.mjs";

const exec = promisify(execFile);
const SERIALIZATION = "PKC-CANDIDATE-MANIFEST-V1: canonical UTF-8 JSON; recursively sorted object keys; array order preserved; LF terminator; fingerprint=SHA-256(manifest bytes without fingerprint field)";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const FORBIDDEN_PATH = /(?:^|\/)(?:\.env(?:\.|$)|secrets?(?:[./]|$)|credentials?(?:[./]|$)|playwright-report(?:\/|$)|test-results?(?:\/|$)|screenshots?(?:\/|$)|logs?(?:\/|$)|[^/]+\.(?:pem|key|p12|pfx|dump|sql|sqlite3?|db|bak|log)$)/i;
const ARTIFACT_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const APPROVED_SOURCE_ASSET = /^(?:assets\/(?:badges|og)\/[^/]+\.(?:svg|png|jpe?g|webp)|assets\/fonts\/[^/]+\.woff2|assets\/models\/[^/]+\.glb)$/i;
const APPROVED_BINARY_ASSET = /^(?:assets\/(?:badges|og)\/[^/]+\.(?:png|jpe?g|webp)|assets\/fonts\/[^/]+\.woff2|assets\/models\/[^/]+\.glb)$/i;
const APPROVED_REPORT_FIXTURE = "reports/boot-motion-performance.json";
const APPROVED_ROLE_SQL = new Set(["db/roles/000_roles.sql", "db/roles/004_onboarding_roles.sql", "db/roles/005_unseal_migrator.sql", "db/roles/006_backup_reader.sql", "db/roles/010_seal_migrator.sql", "db/roles/020_seal_bootstrap.sql"]);
const FORBIDDEN_CREDENTIAL_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk_live_|gh[opusr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/i;
const SECRET_KEY_NAMES = ["password", "passwd", "secret", "token", "authorization", "clientsecret", "databaseurl", "apikey", "accesstoken", "authtoken", "privatekey", "secretkey"];
const EXACT_PLACEHOLDERS = new Set(["<provided-by-secret-manager>", "<redacted>", "EXAMPLE_ONLY_CHANGE_ME", "REPLACE_WITH_SECRET"]);
const MAX_ASSIGNMENT_EXPRESSION_CHARS = 16 * 1024;
const MAX_KEY_LITERAL_CHARS = 1024;
const MAX_SCANNER_TOKENS = 250_000;
const MAX_SCANNER_NESTING = 8_192;
const MAX_SCANNER_WORK = 500_000;
const SHELL_EXTENSIONS = new Set(["sh", "bash", "dash", "ksh", "zsh"]);
const DARWIN_FGETPATH_HELPER = "import fcntl,sys; value=fcntl.fcntl(3, fcntl.F_GETPATH, bytes(1024)); sys.stdout.buffer.write(value.split(bytes([0]),1)[0])";
const DARWIN_HELPER_OUTPUT_LIMIT = 4096;
const DARWIN_HELPER_TIMEOUT_MS = 5000;

async function gitRaw(root, args) {
  const { stdout } = await exec("git", args, { cwd: root, encoding: null, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function gitText(root, args) {
  return (await gitRaw(root, args)).toString("utf8").trim();
}

function safeRelative(path) {
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || path.split(/[\\/]/).includes("..")) throw new Error(`candidate path escapes root or is not relative: ${path}`);
  return path.replaceAll("\\", "/");
}

function enforcePathPolicy(path) {
  if (path === "assets/screenshots/.gitkeep" || APPROVED_ROLE_SQL.has(path) || /^db\/migrations\/[A-Za-z0-9._-]+\.sql$/.test(path)) return;
  if (FORBIDDEN_PATH.test(path)) throw new Error(`forbidden candidate artifact path: ${path}`);
  if (ARTIFACT_IMAGE.test(path) && !APPROVED_SOURCE_ASSET.test(path)) throw new Error(`forbidden candidate image artifact outside explicit source-asset policy: ${path}`);
  if ((path === "reports" || path.startsWith("reports/")) && path !== APPROVED_REPORT_FIXTURE) throw new Error(`forbidden candidate report artifact: ${path}`);
}

function decodeCanonicalText(bytes, path) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`candidate non-binary file contains a forbidden UTF-8 BOM: ${path}`);
  if (bytes.includes(0)) throw new Error(`candidate non-binary file contains NUL and is not canonical UTF-8 text: ${path}`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`candidate non-binary file is not strict canonical UTF-8 text: ${path}`);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`candidate non-binary file is not canonical UTF-8 text: ${path}`);
  return text;
}

function isSensitiveKey(value) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["statustoken", "maketoken", "makesecret"].includes(compact)) return false;
  return SECRET_KEY_NAMES.some((name) => compact === name || compact.endsWith(name));
}

function decodeKeyLiteral(token) {
  if (token.type !== "string" && !(token.type === "template" && token.static)) return null;
  if (token.value.length > MAX_KEY_LITERAL_CHARS) throw new Error(`candidate assignment key literal exceeds ${MAX_KEY_LITERAL_CHARS} character bound`);
  let decoded = "";
  for (let index = 0; index < token.value.length; index += 1) {
    const character = token.value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= token.value.length) return null;
    const escaped = token.value[index];
    if (escaped === "u") {
      if (token.value[index + 1] === "{") {
        const end = token.value.indexOf("}", index + 2);
        if (end === -1) return null;
        const hex = token.value.slice(index + 2, end);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) return null;
        decoded += String.fromCodePoint(codePoint);
        index = end;
      } else {
        const hex = token.value.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      }
    } else if (escaped === "x") {
      const hex = token.value.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (escaped === "\n") {
      // JavaScript line continuation contributes no character.
    } else if (escaped === "\r") {
      if (token.value[index + 1] === "\n") index += 1;
    } else {
      decoded += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" })[escaped] ?? escaped;
    }
    if (decoded.length > MAX_KEY_LITERAL_CHARS) return null;
  }
  return decoded;
}

function scannerPolicy(path, text) {
  const lowerPath = path.toLowerCase();
  const name = lowerPath.split("/").at(-1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  if (SHELL_EXTENSIONS.has(extension) || text.startsWith("#!")) return { colon: false, hashComment: false, slashComment: false, dashComment: false, shellVariableReferences: true };
  if (extension === "css") return { css: true };
  if (extension === "sql") return { colon: false, hashComment: false, slashComment: false, dashComment: true };
  if (["yaml", "yml", "toml", "properties", "conf"].includes(extension)) return { colon: true, hashComment: true, slashComment: false, dashComment: false };
  if (/\.[cm]?[jt]sx?$/.test(lowerPath) || lowerPath.endsWith(".gated-on-supabase")) return { colon: true, hashComment: false, slashComment: true, dashComment: false };
  return { colon: true, hashComment: true, slashComment: false, dashComment: false };
}

function tokenizeAssignments(text, policy) {
  const tokens = [];
  const push = (token) => {
    tokens.push(token);
    if (tokens.length > MAX_SCANNER_TOKENS) throw new Error(`candidate scanner token bound exceeded: ${MAX_SCANNER_TOKENS}`);
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n" || character === "\r") {
      push({ type: "delimiter", value: "\n", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const isLineComment = (policy.hashComment && character === "#")
      || (policy.slashComment && character === "/" && text[index + 1] === "/")
      || (policy.dashComment && character === "-" && text[index + 1] === "-");
    if (isLineComment) {
      const newline = text.indexOf("\n", index + 1);
      if (newline === -1) index = text.length;
      else {
        push({ type: "delimiter", value: "\n", start: newline, end: newline + 1 });
        index = newline + 1;
      }
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const start = index;
      const quote = character;
      let value = "";
      let staticTemplate = true;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\" && index + 1 < text.length) {
          value += text[index] + text[index + 1];
          index += 2;
        } else if (text[index] === quote) {
          index += 1;
          break;
        } else {
          if (quote === "`" && text[index] === "$" && text[index + 1] === "{") staticTemplate = false;
          value += text[index++];
        }
      }
      push({ type: quote === "`" ? "template" : "string", static: staticTemplate, value, start, end: index });
      continue;
    }
    if (character === "=" || (character === ":" && policy.colon)) {
      const previous = text[index - 1] ?? "";
      const next = text[index + 1] ?? "";
      if (character === ":" || (!/[=<>!:+-]/.test(previous) && !/[=>]/.test(next))) push({ type: "operator", value: character, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (/[A-Za-z0-9_$.-]/.test(character) || (character === "\\" && text[index + 1] === "u")) {
      const start = index;
      let value = "";
      while (index < text.length) {
        if (/[A-Za-z0-9_$./{}<>@_-]/.test(text[index])) {
          value += text[index++];
          continue;
        }
        if (text[index] !== "\\" || text[index + 1] !== "u") break;
        if (text[index + 2] === "{") {
          const end = text.indexOf("}", index + 3);
          if (end === -1 || end - index > 10) break;
          const hex = text.slice(index + 3, end);
          const codePoint = /^[0-9a-fA-F]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : 0x110000;
          if (codePoint > 0x10ffff) break;
          value += String.fromCodePoint(codePoint);
          index = end + 1;
        } else {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
        }
      }
      push({ type: "identifier", value, start, end: index });
      continue;
    }
    push({ type: ";,".includes(character) ? "delimiter" : "punctuation", value: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function buildTokenMetadata(tokens) {
  const previous = new Int32Array(tokens.length);
  const matching = new Int32Array(tokens.length).fill(-1);
  const depthBefore = new Int32Array(tokens.length);
  const stack = [];
  let prior = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    previous[index] = prior;
    const entry = tokens[index];
    if (!(entry.type === "delimiter" && entry.value === "\n")) prior = index;
    depthBefore[index] = stack.length;
    if (entry.type !== "punctuation") continue;
    if ('([{'.includes(entry.value)) {
      stack.push(index);
      if (stack.length > MAX_SCANNER_NESTING) throw new Error(`candidate scanner nesting bound exceeded: ${MAX_SCANNER_NESTING}`);
      continue;
    }
    const expected = ({ ")": "(", "]": "[", "}": "{" })[entry.value];
    if (expected && stack.length > 0 && tokens[stack.at(-1)].value === expected) {
      const open = stack.pop();
      matching[open] = index;
      matching[index] = open;
    }
  }

  const nextBoundary = new Int32Array(tokens.length).fill(tokens.length);
  const nextAtDepth = new Map();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const depth = depthBefore[index];
    nextBoundary[index] = nextAtDepth.get(depth) ?? tokens.length;
    const entry = tokens[index];
    if (entry.type === "delimiter" || (entry.type === "punctuation" && ")]}".includes(entry.value))) nextAtDepth.set(depth, index);
  }
  return { previous, matching, nextBoundary };
}

function addScannerWork(work, amount) {
  work.count += amount;
  if (work.count > MAX_SCANNER_WORK) throw new Error(`candidate scanner aggregate work bound exceeded: ${MAX_SCANNER_WORK}`);
}

function resolveStaticStringExpression(source, work) {
  if (source.length > MAX_ASSIGNMENT_EXPRESSION_CHARS) return null;
  addScannerWork(work, source.length * 2);
  let index = 0;
  let nesting = 0;
  const frames = [{ type: "expression", terminator: null, value: "", expectPrimary: true, awaiting: false }];

  const append = (frame, value) => {
    frame.value += value;
    if (frame.value.length > MAX_KEY_LITERAL_CHARS) throw new Error(`candidate assignment key literal exceeds ${MAX_KEY_LITERAL_CHARS} character bound`);
  };
  const deliver = (value) => {
    const parent = frames.at(-1);
    if (!parent || !parent.awaiting) return false;
    append(parent, value);
    parent.awaiting = false;
    if (parent.type === "expression") parent.expectPrimary = false;
    return true;
  };
  const skipIgnorable = () => {
    while (index < source.length) {
      if (/\s/.test(source[index])) { index += 1; continue; }
      if (source[index] === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end === -1) { index = source.length; return; }
        index = end + 2;
        continue;
      }
      if (source[index] === "/" && source[index + 1] === "/") {
        const end = source.indexOf("\n", index + 2);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      break;
    }
  };
  const readQuoted = (quote) => {
    const start = ++index;
    while (index < source.length) {
      if (source[index] === "\n" || source[index] === "\r") return null;
      if (source[index] === "\\") { index += 2; continue; }
      if (source[index] === quote) {
        const literal = { type: "string", value: source.slice(start, index) };
        index += 1;
        return decodeKeyLiteral(literal);
      }
      index += 1;
    }
    return null;
  };
  const pushFrame = (frame) => {
    nesting += 1;
    if (nesting > MAX_SCANNER_NESTING) throw new Error(`candidate scanner nesting bound exceeded: ${MAX_SCANNER_NESTING}`);
    frames.push(frame);
  };
  const finishFrame = () => {
    const finished = frames.pop();
    nesting -= 1;
    return frames.length === 0 ? finished.value : (deliver(finished.value) ? undefined : null);
  };

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame.type === "template") {
      const rawStart = index;
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) { index += 2; continue; }
        if (source[index] === "`" || (source[index] === "$" && source[index + 1] === "{")) break;
        index += 1;
      }
      const raw = decodeKeyLiteral({ type: "string", value: source.slice(rawStart, index) });
      if (raw === null) return null;
      append(frame, raw);
      if (index >= source.length) return null;
      if (source[index] === "`") {
        index += 1;
        const result = finishFrame();
        if (result === null) return null;
        if (result !== undefined) return index === source.length ? result : null;
        continue;
      }
      index += 2;
      frame.awaiting = true;
      pushFrame({ type: "expression", terminator: "}", value: "", expectPrimary: true, awaiting: false });
      continue;
    }

    skipIgnorable();
    if (frame.awaiting) return null;
    if (frame.terminator !== null && source[index] === frame.terminator) {
      if (frame.expectPrimary) return null;
      index += 1;
      const result = finishFrame();
      if (result === null) return null;
      if (result !== undefined) return index === source.length ? result : null;
      continue;
    }
    if (index >= source.length) {
      if (frame.terminator !== null || frame.expectPrimary) return null;
      frames.pop();
      return frames.length === 0 ? frame.value : null;
    }
    if (!frame.expectPrimary) {
      if (source[index] !== "+") return null;
      frame.expectPrimary = true;
      index += 1;
      continue;
    }
    const character = source[index];
    if (character === '"' || character === "'") {
      const value = readQuoted(character);
      if (value === null) return null;
      append(frame, value);
      frame.expectPrimary = false;
      continue;
    }
    if (character === "(") {
      index += 1;
      frame.awaiting = true;
      pushFrame({ type: "expression", terminator: ")", value: "", expectPrimary: true, awaiting: false });
      continue;
    }
    if (character === "`") {
      index += 1;
      frame.awaiting = true;
      pushFrame({ type: "template", value: "", awaiting: false });
      continue;
    }
    return null;
  }
  return null;
}

function resolvedAssignmentKey(tokens, metadata, operatorIndex, text, work) {
  const cursor = metadata.previous[operatorIndex];
  const key = tokens[cursor];
  if (key?.type === "identifier") return { computed: false, key: key.value };
  if (key?.type === "string" || key?.type === "template") return { computed: false, key: decodeKeyLiteral(key) };
  if (!(key?.type === "punctuation" && key.value === "]")) return { computed: false, objectKey: false, key: null };
  const open = metadata.matching[cursor];
  if (open < 0) return { computed: true, objectKey: false, key: null };
  const beforeOpen = metadata.previous[open];
  const prior = tokens[beforeOpen];
  const objectKey = (prior?.type === "punctuation" && prior.value === "{")
    || (prior?.type === "delimiter" && prior.value === ",");
  const source = text.slice(tokens[open].end, key.start);
  return { computed: true, objectKey, key: resolveStaticStringExpression(source, work) };
}

function isAllowedSensitiveExpression(tokens, start, end, text, permitRuntimeReferences, permitShellVariableReferences, work) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let index = start; index < end; index += 1) {
    work.count += 1;
    if (work.count > MAX_SCANNER_WORK) throw new Error(`candidate scanner aggregate work bound exceeded: ${MAX_SCANNER_WORK}`);
    if (tokens[index].type === "delimiter" && tokens[index].value === "\n") continue;
    if (first < 0) first = index;
    last = index;
    count += 1;
  }
  if (count === 0) return false;
  const raw = text.slice(tokens[first].start, tokens[last].end).trim();
  if (EXACT_PLACEHOLDERS.has(raw)) return true;
  if (permitShellVariableReferences && /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|"\$[A-Za-z_][A-Za-z0-9_]*"|"\$\{[A-Za-z_][A-Za-z0-9_]*\}")$/.test(raw)) return true;
  if (count === 1 && tokens[first].type === "string") return EXACT_PLACEHOLDERS.has(decodeKeyLiteral(tokens[first]));
  if (count === 1 && tokens[first].type === "identifier") {
    const value = tokens[first].value;
    const looksLikeOpaqueLiteral = value.length >= 20 && (
      /^(.)\1{19,}$/.test(value)
      || (/^[A-Za-z0-9_-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value))
    );
    if (looksLikeOpaqueLiteral) return false;
    return permitRuntimeReferences && (
      /^(?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*$/.test(value)
      || /^(?:process\.env|import\.meta\.env|\$env)\.[A-Z][A-Z0-9_]*$/.test(value)
    );
  }
  return permitRuntimeReferences && /^(?:Deno\.env\.get|env)\(["'][A-Z][A-Z0-9_]*["']\)$/.test(raw);
}

function normalizeCssComments(text, work) {
  const chunks = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    addScannerWork(work, 1);
    if (text[index] !== "/" || text[index + 1] !== "*") { index += 1; continue; }
    chunks.push(text.slice(cursor, index));
    const start = index;
    index += 2;
    while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
      addScannerWork(work, 1);
      index += 1;
    }
    if (index < text.length) { addScannerWork(work, 2); index += 2; }
    const comment = text.slice(start, index);
    chunks.push(comment.replace(/[^\r\n]/g, " "));
    cursor = index;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

function readCssCustomPropertyName(text, start, work) {
  let index = start;
  let decoded = "";
  while (index < text.length) {
    addScannerWork(work, 1);
    const character = text[index];
    if (/[A-Za-z0-9_-]/.test(character)) {
      decoded += character;
      index += 1;
    } else if (character.charCodeAt(0) >= 0x80) {
      const codePoint = text.codePointAt(index);
      decoded += String.fromCodePoint(codePoint);
      index += codePoint > 0xffff ? 2 : 1;
    } else if (character === "\\") {
      const escapeStart = index++;
      let hex = "";
      while (hex.length < 6 && index < text.length && /[0-9a-fA-F]/.test(text[index])) hex += text[index++];
      if (hex.length > 0) {
        let codePoint = Number.parseInt(hex, 16);
        if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) codePoint = 0xfffd;
        decoded += String.fromCodePoint(codePoint);
        if (text[index] === "\r" && text[index + 1] === "\n") index += 2;
        else if (/\s/.test(text[index] ?? "")) index += 1;
      } else if (index < text.length && text[index] !== "\r" && text[index] !== "\n" && text[index] !== "\f") {
        decoded += text[index++];
      } else {
        index = escapeStart;
        break;
      }
    } else {
      break;
    }
    if (decoded.length > MAX_KEY_LITERAL_CHARS || index - start > MAX_KEY_LITERAL_CHARS * 8) {
      throw new Error(`candidate CSS custom-property name exceeds ${MAX_KEY_LITERAL_CHARS} decoded character bound`);
    }
  }
  return { decoded, end: index };
}

function containsUnsafeCssCustomProperty(source) {
  const work = { count: 0 };
  const text = normalizeCssComments(source, work);
  let index = 0;
  while (index < text.length) {
    addScannerWork(work, 1);
    if (text[index] !== "-" || text[index + 1] !== "-") { index += 1; continue; }
    const { decoded: name, end } = readCssCustomPropertyName(text, index + 2, work);
    index = end;
    while (index < text.length && /\s/.test(text[index])) { addScannerWork(work, 1); index += 1; }
    if (text[index] !== ":" || !isSensitiveKey(name)) continue;
    const valueStart = ++index;
    while (index < text.length && text[index] !== ";" && text[index] !== "}") {
      addScannerWork(work, 1);
      index += 1;
      if (index - valueStart > MAX_ASSIGNMENT_EXPRESSION_CHARS) return true;
    }
    const value = text.slice(valueStart, index).trim();
    const unquoted = (/^(["']).*\1$/.test(value)) ? value.slice(1, -1) : value;
    if (!EXACT_PLACEHOLDERS.has(unquoted)) return true;
  }
  return false;
}

function containsUnsafeSensitiveAssignment(text, path) {
  const policy = scannerPolicy(path, text);
  if (policy.css) return containsUnsafeCssCustomProperty(text);
  const permitRuntimeReferences = /(?:\.[cm]?[jt]sx?|\.gated-on-supabase)$/.test(path);
  const tokens = tokenizeAssignments(text, policy);
  const metadata = buildTokenMetadata(tokens);
  const work = { count: tokens.length };
  if (work.count > MAX_SCANNER_WORK) throw new Error(`candidate scanner aggregate work bound exceeded: ${MAX_SCANNER_WORK}`);
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index].type !== "operator") continue;
    const keyIndex = metadata.previous[index];
    const beforeKeyIndex = keyIndex < 0 ? -1 : metadata.previous[keyIndex];
    if (tokens[index].value === ":" && tokens[beforeKeyIndex]?.type === "punctuation" && tokens[beforeKeyIndex]?.value === "?") continue;
    const resolved = resolvedAssignmentKey(tokens, metadata, index, text, work);
    if (resolved.objectKey && resolved.key === null && tokens[index].value === ":") return true;
    if (resolved.key === null || !isSensitiveKey(resolved.key)) continue;
    const end = metadata.nextBoundary[index];
    const last = end > index + 1 ? tokens[end - 1] : null;
    if (last && last.end - tokens[index].end > MAX_ASSIGNMENT_EXPRESSION_CHARS) return true;
    if (!isAllowedSensitiveExpression(tokens, index + 1, end, text, permitRuntimeReferences, policy.shellVariableReferences === true, work)) return true;
  }
  return false;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function snapshotDirectoryChain(root, filePath) {
  const parentRelative = relative(root, dirname(filePath));
  const segments = parentRelative === "" ? [] : parentRelative.split(sep);
  const snapshots = [];
  let current = root;
  for (const segment of [null, ...segments]) {
    if (segment !== null) current = join(current, segment);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`candidate symlink ancestor rejected: ${current}`);
    if (!stat.isDirectory()) throw new Error(`candidate ancestor is not a real directory: ${current}`);
    snapshots.push({ path: current, stat });
  }
  return snapshots;
}

async function recheckDirectoryChain(snapshots) {
  for (const snapshot of snapshots) {
    const stat = await lstat(snapshot.path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(snapshot.stat, stat)) throw new Error(`candidate root or ancestor identity changed during read: ${snapshot.path}`);
  }
}

function assertContained(root, absolute, label) {
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`candidate descriptor containment cannot be proven for ${label}`);
}

async function darwinDescriptorPath(descriptor) {
  return new Promise((resolvePath, rejectPath) => {
    const child = spawn("/usr/bin/python3", ["-I", "-S", "-c", DARWIN_FGETPATH_HELPER], {
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPath(error);
      else resolvePath(value);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("candidate Darwin descriptor-path helper timed out"));
    }, DARWIN_HELPER_TIMEOUT_MS);
    child.once("error", (error) => finish(new Error(`candidate Darwin descriptor-path helper failed: ${error.message}`)));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > DARWIN_HELPER_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("candidate Darwin descriptor-path helper exceeded stdout bound"));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > DARWIN_HELPER_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("candidate Darwin descriptor-path helper exceeded stderr bound"));
      }
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      if (status !== 0 || signal !== null || stderrBytes !== 0) {
        finish(new Error("candidate Darwin descriptor-path helper rejected the descriptor"));
        return;
      }
      let value;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
      } catch {
        finish(new Error("candidate Darwin descriptor-path helper returned non-UTF-8 output"));
        return;
      }
      if (!isAbsolute(value) || value.includes("\0")) {
        finish(new Error("candidate Darwin descriptor-path helper returned an invalid path"));
        return;
      }
      finish(null, value);
    });
  });
}

async function boundedRead(root, path, expected) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("candidate descriptor identity cannot be proven: O_NOFOLLOW unavailable");
  const ancestors = await snapshotDirectoryChain(root, path);
  const leafBefore = await lstat(path, { bigint: true });
  if (leafBefore.isSymbolicLink()) throw new Error(`candidate symlink rejected: ${path}`);
  if (!leafBefore.isFile() || !sameIdentity(leafBefore, expected)) throw new Error(`candidate file identity changed before open: ${path}`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(before, leafBefore) || before.size > BigInt(MAX_FILE_BYTES)) throw new Error(`candidate opened descriptor identity changed or exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    let descriptorPath;
    if (process.platform === "linux") descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
    else if (process.platform === "darwin") descriptorPath = await darwinDescriptorPath(handle.fd);
    else throw new Error("candidate descriptor containment cannot be proven on this platform");
    assertContained(root, descriptorPath, path);
    if (descriptorPath !== path) throw new Error(`candidate opened descriptor does not equal intended canonical path: ${path}`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`candidate file truncated during read: ${path}`);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const leafAfter = await lstat(path, { bigint: true });
    if (!sameIdentity(after, before) || !sameIdentity(leafAfter, before)) throw new Error(`candidate file identity changed during bounded read: ${path}`);
    await recheckDirectoryChain(ancestors);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inventory(root, includePaths) {
  let names;
  if (includePaths) names = includePaths.map(safeRelative);
  else {
    const [tracked, untracked] = await Promise.all([
      gitRaw(root, ["ls-files", "-z", "--cached"]),
      gitRaw(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]);
    names = Buffer.concat([tracked, untracked]).toString("utf8").split("\0").filter(Boolean).map(safeRelative);
  }
  names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  if (new Set(names).size !== names.length) throw new Error("duplicate candidate path");
  return names;
}

export async function buildCandidateManifest(rootInput, options = {}) {
  const root = await realpath(rootInput);
  const rootStat = await lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("candidate canonical root must be a real directory, not a symlink");
  const names = await inventory(root, options.includePaths);
  const files = [];
  let totalBytes = 0;
  for (const path of names) {
    enforcePathPolicy(path);
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`candidate path escapes root: ${path}`);
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`candidate symlink rejected: ${path}`);
    if (!stat.isFile()) throw new Error(`candidate entry is not a regular file: ${path}`);
    if (stat.size > BigInt(MAX_FILE_BYTES)) throw new Error(`candidate file exceeds ${MAX_FILE_BYTES} byte limit: ${path}`);
    totalBytes += Number(stat.size);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`candidate aggregate exceeds ${MAX_TOTAL_BYTES} byte limit before file read`);
    const bytes = await boundedRead(root, absolute, stat);
    if (!APPROVED_BINARY_ASSET.test(path)) {
      const text = decodeCanonicalText(bytes, path);
      if (FORBIDDEN_CREDENTIAL_MARKER.test(text) || containsUnsafeSensitiveAssignment(text, path)) throw new Error(`secret-like value policy or unsafe sensitive assignment match in candidate: ${path}`);
    }
    files.push({ path, bytes: bytes.length, mode: Number(stat.mode & 0o777n), sha256: sha256(bytes) });
  }
  const [headCommit, headTree, status] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]).catch(() => "UNBORN"),
    gitText(root, ["rev-parse", "HEAD^{tree}"]).catch(() => "UNBORN"),
    gitRaw(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const body = { schemaVersion: 1, serialization: SERIALIZATION, snapshot: { headCommit, headTree, dirty: status.length > 0, statusDigest: sha256(status) }, files };
  return { ...body, fingerprint: sha256(canonicalJson(body)) };
}

export async function verifyCandidateManifest(root, expected) {
  const actual = await buildCandidateManifest(root);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("candidate manifest verification failed: bytes or snapshot changed");
  return { ok: true, fingerprint: actual.fingerprint };
}

export { SERIALIZATION as CANDIDATE_SERIALIZATION, MAX_FILE_BYTES as CANDIDATE_MAX_FILE_BYTES, MAX_TOTAL_BYTES as CANDIDATE_MAX_TOTAL_BYTES };
