import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { buildCandidateManifest } from "../../server/ops/candidate.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const temporaryRoots = new Set();

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function disposableRepo(files) {
  const repo = await temporaryRoot("pkc-v3-holds-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), value);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  return repo;
}

function runCli(name, args = []) {
  return spawnSync(process.execPath, [join(ROOT, "scripts/ops", `${name}.mjs`), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function sourceAssignment(key, rhs) {
  return `const ${key} = ${rhs};\n`;
}

test("candidate rejects a tracked file reached through a symlinked ancestor", async () => {
  const repo = await disposableRepo({ "nested/inside.txt": "tracked bytes\n" });
  const outside = await temporaryRoot("pkc-v3-outside-");
  await writeFile(join(outside, "inside.txt"), "outside bytes must not be trusted\n");
  await rm(join(repo, "nested"), { recursive: true });
  await symlink(outside, join(repo, "nested"), "dir");
  await assert.rejects(buildCandidateManifest(repo, { includePaths: ["nested/inside.txt"] }), /symlink.*ancestor|ancestor.*symlink/i);
});

test("candidate rejects a direct leaf symlink", async () => {
  const repo = await disposableRepo({ "leaf.txt": "tracked bytes\n", "target.txt": "target bytes\n" });
  await rm(join(repo, "leaf.txt"));
  await symlink("target.txt", join(repo, "leaf.txt"));
  await assert.rejects(buildCandidateManifest(repo), /symlink/i);
});

test("candidate accepts a normal nested regular file", async () => {
  const candidateSource = await readFile(join(ROOT, "server/ops/candidate.mjs"), "utf8");
  assert.match(candidateSource, /\/proc\/self\/fd/);
  assert.match(candidateSource, /fcntl\.F_GETPATH/);
  assert.match(candidateSource, /\/usr\/bin\/python3/);
  assert.match(candidateSource, /stdio: \["ignore", "pipe", "pipe", descriptor\]/);
  const repo = await disposableRepo({ "one/two/inside.txt": "ordinary nested text\n" });
  const manifest = await buildCandidateManifest(repo);
  assert.deepEqual(manifest.files.map(({ path }) => path), ["one/two/inside.txt"]);
});

for (const [label, bytes] of [
  ["UTF-8 BOM", Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
  ["overlong UTF-8", Buffer.from([0xc0, 0xaf])],
  ["UTF-8 surrogate", Buffer.from([0xed, 0xa0, 0x80])],
  ["malformed UTF-8", Buffer.from([0xf0, 0x28, 0x8c, 0xbc])],
  ["NUL", Buffer.from([0x61, 0x00, 0x62])],
]) {
  test(`candidate rejects ${label} in every non-approved-binary file`, async () => {
    const repo = await disposableRepo({ "source.txt": bytes });
    await assert.rejects(buildCandidateManifest(repo), /BOM|NUL|UTF-8|canonical text/i);
  });
}

for (const [label, key, rhs] of [
  ["concatenated literals", "password", `"hard" + "coded"`],
  ["Buffer.from decoding", "token", `Buffer.from("c2Vuc2l0aXZlLWJ5dGVz", "base64")`],
  ["atob decoding", "secret", `atob("c2Vuc2l0aXZlLWJ5dGVz")`],
  ["generic decoding", "apiKey", `decode("c2Vuc2l0aXZlLWJ5dGVz")`],
  ["template construction", "clientSecret", "`sample-${runtimePart}`"],
  ["object literal construction", "secret", `{ value: "hardcoded" }`],
  ["array literal construction", "token", `["hardcoded"]`],
  ["placeholder-prefixed long literal", "authorization", `"sample-${"x".repeat(64)}"`],
  ["direct short literal", "password", `"short"`],
]) {
  test(`candidate default-denies sensitive RHS ${label}`, async () => {
    const repo = await disposableRepo({ "hostile.mjs": sourceAssignment(key, rhs) });
    await assert.rejects(buildCandidateManifest(repo), /sensitive assignment|secret-like value policy/i);
  });
}

test("candidate permits only exact placeholders, direct environment references, and simple runtime references", async () => {
  const repo = await disposableRepo({
    "safe.mjs": [
      sourceAssignment("password", `"<provided-by-secret-manager>"`).trimEnd(),
      sourceAssignment("token", "process.env.RUNTIME_TOKEN").trimEnd(),
      sourceAssignment("secret", "$env.RUNTIME_SECRET").trimEnd(),
      sourceAssignment("apiKey", "dependencies.runtimeKey").trimEnd(),
      sourceAssignment("authorization", "runtimeAuthorization").trimEnd(),
      "",
    ].join("\n"),
  });
  await buildCandidateManifest(repo);
});

test("candidate shell authority accepts the complete exact-variable matrix and rejects compound lookalikes", async () => {
  const accepted = ["$NAME", "${NAME}", '"$NAME"', '"${NAME}"'];
  for (const [index, rhs] of accepted.entries()) {
    const repo = await disposableRepo(Object.fromEntries([[`safe-${index}.bash`, `#!/usr/bin/env bash\ntoken=${rhs}\n`]]));
    await buildCandidateManifest(repo);
  }

  const rejected = [
    "'$NAME'", "'${NAME}'", "$(command)", "$((2 + 2))", "static", '"static"',
    "pre$NAME", "$NAME-post", "${NAME:-fallback}", "${!NAME}", "$NAME${OTHER}",
    '"$NAME$(command)"',
  ];
  for (const [index, rhs] of rejected.entries()) {
    const repo = await disposableRepo(Object.fromEntries([[`unsafe-${index}.bash`, `#!/usr/bin/env bash\n# token=${rhs}\n`]]));
    await assert.rejects(buildCandidateManifest(repo), /sensitive assignment|secret-like value policy/i, rhs);
  }
});

for (const family of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]) {
  test(`candidate rejects ${family} credentials even in comments`, async () => {
    const value = `${family}${"A".repeat(24)}`;
    const repo = await disposableRepo({ "comment.txt": `# credential example: ${value}\n` });
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy/i);
  });
}

test("help is accepted only as the sole argument for every operations CLI", () => {
  for (const name of ["candidate", "keys", "restore", "vercel", "n8n-retention", "monitor", "receipt"]) {
    assert.equal(runCli(name, ["--help"]).status, 0, name);
    for (const args of [["--help", "garbage"], ["nonsense", "--help"], ["--help", "--help"]]) {
      assert.notEqual(runCli(name, args).status, 0, `${name}: ${args.join(" ")}`);
    }
  }
});

test("candidate CLI rejects reordered, duplicate, trailing, missing, and empty options", () => {
  for (const args of [
    ["manifest", "--root", ""],
    ["manifest", "--root"],
    ["manifest", "--root", ROOT, "--root", ROOT],
    ["manifest", "--output", "/tmp/out", "--root", ROOT],
    ["manifest", "--root", ROOT, "garbage"],
    ["verify", "--input", "", "--root", ROOT],
    ["verify", "--input", "/tmp/missing", "--root", ROOT],
  ]) assert.notEqual(runCli("candidate", args).status, 0, args.join(" "));
});

test("keys CLI rejects reordered, duplicate, trailing, missing, and empty options", () => {
  for (const args of [
    ["generate", "--directory", ""],
    ["generate", "--directory"],
    ["generate", "--version", "1", "--directory", "/tmp/keys"],
    ["cleanup", "--directory", "/tmp/keys", "--version", "1", "--version", "1"],
    ["probe", "--kids", "kid", "--input", "/tmp/missing"],
    ["rotation-plan", "--from", "a", "--to", "b", "--dependent-rows", "0", "garbage"],
  ]) assert.notEqual(runCli("keys", args).status, 0, args.join(" "));
});

test("n8n-retention CLI implements exact per-command grammars", () => {
  assert.equal(runCli("n8n-retention", ["retention-manifest"]).status, 0);
  for (const args of [
    ["retention-manifest", "garbage"],
    ["scan"],
    ["scan", "--input", ""],
    ["scan", "--canaries", "x", "--input", "/tmp/missing"],
    ["scan", "--input", "/tmp/missing", "--input", "/tmp/missing"],
    ["purge-plan", "--input"],
    ["apply", "--approval", "/tmp/missing", "--plan", "/tmp/missing"],
    ["apply", "--plan", "/tmp/missing", "--enable-destructive", "--enable-destructive", "--approval", "/tmp/missing"],
  ]) assert.notEqual(runCli("n8n-retention", args).status, 0, args.join(" "));
});

test("receipt CLI requires exact ordered nonempty type and input options", () => {
  for (const args of [
    ["verify", "--input", "/tmp/missing", "--type", "mutation"],
    ["verify", "--type", "", "--input", "/tmp/missing"],
    ["verify", "--type", "mutation", "--input", ""],
    ["verify", "--type", "mutation", "--type", "mutation", "--input", "/tmp/missing"],
    ["verify", "--type", "mutation", "--input", "/tmp/missing", "garbage"],
  ]) assert.notEqual(runCli("receipt", args).status, 0, args.join(" "));
});
