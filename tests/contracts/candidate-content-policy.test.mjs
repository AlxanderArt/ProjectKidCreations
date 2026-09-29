import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { buildCandidateManifest } from "../../server/ops/candidate.mjs";

const temporaryRoots = new Set();

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

async function disposableRepo(files) {
  const repo = await temporaryRoot("pkc-candidate-content-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), value);
  }
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}

const hostileValue = (character) => character.repeat(24);
const singleFile = (path, content) => Object.fromEntries([[path, content]]);

test("candidate admits and inventories only the exact canonical role authority SQL paths", async () => {
  const paths = ["db/roles/000_roles.sql", "db/roles/005_unseal_migrator.sql", "db/roles/010_seal_migrator.sql"];
  const repo = await disposableRepo(Object.fromEntries(paths.map((path) => [path, "SELECT 1;\n"])));
  const manifest = await buildCandidateManifest(repo);
  assert.deepEqual(manifest.files.map(({ path: candidatePath }) => candidatePath), paths);
});

test("candidate still secret-scans every exact role authority SQL path", async () => {
  for (const path of ["db/roles/000_roles.sql", "db/roles/005_unseal_migrator.sql", "db/roles/010_seal_migrator.sql"]) {
    const repo = await disposableRepo(singleFile(path, `password = '${hostileValue("R")}'\n`));
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
  }
});

test("candidate rejects noncanonical bytes at the exact role authority SQL path", async () => {
  const repo = await disposableRepo(singleFile("db/roles/000_roles.sql", Buffer.from([0x53, 0x45, 0x4c, 0x80, 0x43, 0x54])));
  await assert.rejects(buildCandidateManifest(repo), /UTF-8|canonical text/i);
});

for (const path of [
  "db/roles/001_roles.sql",
  "db/roles/006_unseal_migrator.sql",
  "db/roles/nested/000_roles.sql",
  "db/roles/000_ROLES.sql",
  "arbitrary.sql",
]) {
  test(`candidate rejects neighboring SQL path ${path}`, async () => {
    const repo = await disposableRepo(singleFile(path, "SELECT 1;\n"));
    await assert.rejects(buildCandidateManifest(repo), /forbidden candidate artifact path/i);
  });
}

for (const [label, path, content] of [
  ["quoted JSON", "config.json", `{"client_secret":"${hostileValue("J")}"}\n`],
  ["quoted YAML", "config.yaml", `'api-key': '${hostileValue("Y")}'\n`],
  ["TOML", "config.toml", `database_url = "${hostileValue("T")}"\n`],
  ["properties", "app.properties", `auth.token=${hostileValue("P")}\n`],
  ["unquoted mixed token", "config.conf", "access-token=aB3dE5gH7jK9mN2pQ4rS\n"],
  ["extensionless script", "run-secret-check", `#!/bin/sh\nauthorization=${hostileValue("S")}\n`],
  ["unknown extension text", "config.opaque", `access_token: ${hostileValue("O")}\n`],
  ["migration SQL", "db/migrations/001_policy.sql", `password = '${hostileValue("M")}'\n`],
]) {
  test(`candidate rejects ${label} secret assignments`, async () => {
    const repo = await disposableRepo(singleFile(path, content));
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
  });
}

test("candidate rejects NUL-bearing source instead of treating it as unscanned binary", async () => {
  const repo = await disposableRepo({ "source.js": Buffer.from("const safe = true;\0ignored") });
  await assert.rejects(buildCandidateManifest(repo), /NUL|UTF-8|text/i);
});

test("candidate rejects invalid UTF-8 in source, extensionless, and unclassified files", async () => {
  for (const path of ["source.js", "runner", "data.unknown"]) {
    const repo = await disposableRepo(singleFile(path, Buffer.from([0x66, 0x6f, 0x80, 0x6f])));
    await assert.rejects(buildCandidateManifest(repo), /UTF-8|text/i, path);
  }
});

test("candidate accepts strict UTF-8 text regardless of extension", async () => {
  const repo = await disposableRepo({ "notes.unknown": "ordinary text — canonical UTF-8\n", runner: "#!/bin/sh\nprintf safe\n" });
  const manifest = await buildCandidateManifest(repo);
  assert.deepEqual(manifest.files.map(({ path }) => path), ["notes.unknown", "runner"]);
});

test("candidate ignores ordinary comments and documented example assignments", async () => {
  const repo = await disposableRepo({
    "safe.toml": [
      `# password = "${hostileValue("C")}"`,
      'password = "EXAMPLE_ONLY_CHANGE_ME" # documented placeholder',
      'client-secret = "<provided-by-secret-manager>"',
      "",
    ].join("\n"),
  });
  await buildCandidateManifest(repo);
});

test("candidate accepts exact placeholders and clearly runtime-derived sensitive values", async () => {
  const repo = await disposableRepo({
    "fixture.js": [
      "const payload = { current_password: process.env.CURRENT_PASSWORD, new_password: dependencies.nextPassword };",
      "const secret = payload.encryptedSecret;",
      "const token = dependencies.randomToken;",
      "const manualSecret = replacementSecret;",
      "",
    ].join("\n"),
  });
  await buildCandidateManifest(repo);
});

for (const [label, path, content] of [
  ["JavaScript newline before assignment operator", "js-newline-before-operator.mjs", `const password\n= "${hostileValue("N")}";\n`],
  ["JSON newline before colon", "json-newline-before-colon.json", `{"token"\n: "${hostileValue("C")}"}\n`],
  ["JSON Unicode-escaped sensitive key", "json-escaped-key.json", String.raw`{"pass\u0077ord":"${hostileValue("U")}"}` + "\n"],
  ["JavaScript computed sensitive string key", "js-computed-key.mjs", `const payload = { ["password"]: "${hostileValue("L")}" };\n`],
  ["JavaScript computed concatenated sensitive key", "js-composed-key.mjs", `const payload = { ["pass" + "word"]: "${hostileValue("K")}" };\n`],
]) {
  test(`candidate rejects ${label}`, async () => {
    const repo = await disposableRepo(singleFile(path, content));
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
  });
}

test("candidate fails closed when a computed key exceeds the literal decoder bound", async () => {
  const repo = await disposableRepo({
    "js-bounded-computed-key.mjs": `const payload = { ["${"x".repeat(1024)}" + "password"]: "${hostileValue("B")}" };\n`,
  });
  await assert.rejects(buildCandidateManifest(repo), /assignment key|literal|bound|secret-like value policy/i);
});

test("candidate accepts newline-formatted approved sensitive assignments", async () => {
  const repo = await disposableRepo({
    "safe-newlines.mjs": "const password\n= process.env.PASSWORD;\n",
    "safe-newlines.json": "{\"token\"\n: \"<redacted>\"}\n",
  });
  await buildCandidateManifest(repo);
});

test("candidate accepts multiline ternary formatting", async () => {
  const repo = await disposableRepo({
    "safe-ternary.mjs": 'const selected = condition\n  ? "runtime token"\n  : "fallback token";\n',
  });
  await buildCandidateManifest(repo);
});

test("candidate accepts bracketed selectors in non-JavaScript text", async () => {
  const repo = await disposableRepo({
    "styles.css": '.action[data-kind="unlock"]:hover { color: var(--accent); }\n',
  });
  await buildCandidateManifest(repo);
});

test("candidate accepts escaped and computed non-sensitive keys", async () => {
  const repo = await disposableRepo({
    "safe-escaped.json": String.raw`{"displ\u0061y_name":"${hostileValue("E")}"}` + "\n",
    "safe-computed.mjs": `const payload = { ["display" + "Name"]: "${hostileValue("S")}" };\n`,
  });
  await buildCandidateManifest(repo);
});

for (const [label, content] of [
  ["parenthesized computed key", `const payload = { [("password")]: "${hostileValue("P")}" };\n`],
  ["parenthesized concatenated computed key", `const payload = { [("pass" + "word")]: "${hostileValue("Q")}" };\n`],
  ["static template computed key", `const payload = { [\`password\`]: "${hostileValue("T")}" };\n`],
  ["Unicode-escaped identifier key", String.raw`const payload = { pass\u0077ord: "${hostileValue("U")}" };` + "\n"],
]) {
  test(`candidate rejects JavaScript ${label}`, async () => {
    const repo = await disposableRepo({ "semantic-bypass.mjs": content });
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
  });
}

test("candidate scans sensitive CSS custom properties without treating CSS -- as a comment", async () => {
  const repo = await disposableRepo({
    "styles.css": `:root { --api-token: ${hostileValue("C")}; }\n`,
  });
  await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
});

test("candidate does not apply object/config colon semantics to CSS selectors", async () => {
  const repo = await disposableRepo({
    "styles.css": ".password:focus { outline: 2px solid currentColor; }\n",
  });
  await buildCandidateManifest(repo);
});

test("candidate preserves SQL and YAML line-comment controls", async () => {
  const repo = await disposableRepo({
    "db/migrations/001_safe.sql": `-- password = '${hostileValue("S")}'\nSELECT 1;\n`,
    "safe.yaml": `# password: ${hostileValue("Y")}\npublic: true\n`,
  });
  await buildCandidateManifest(repo);
});

for (const [label, path, content] of [
  ["CSS comment before the declaration colon", "comment-boundary.css", `:root { --api-token/**/: ${hostileValue("A")}; }\n`],
  ["CSS escape in a sensitive custom-property name", "escaped-sensitive.css", String.raw`:root { --api\2d token: ${hostileValue("E")}; }` + "\n"],
  ["extensionless sh URL before a secret assignment", "run", `#!/bin/sh\nhttps://example.invalid; password=${hostileValue("H")}\n`],
  ["extensionless bash URL before a secret assignment", "deploy", `#!/usr/bin/env bash\nhttps://example.invalid; password=${hostileValue("B")}\n`],
  ["unknown extensionless URL before a secret assignment", "instructions", `https://example.invalid; password=${hostileValue("U")}\n`],
  ["static interpolated sensitive computed key", "interpolated-key.mjs", `const value = { [\`pass\${"word"}\`]: "${hostileValue("I")}" };\n`],
  ["nested static interpolated sensitive computed key", "nested-interpolated-key.mjs", `const value = { [\`pa\${("ss" + \`wo\${"rd"}\`)}\`]: "${hostileValue("N")}" };\n`],
  ["dynamic non-sensitive computed assignment key", "dynamic-key.mjs", `const field = "displayName"; const value = { [field]: "ordinary" };\n`],
  ["dynamic computed assignment key after a static member", "dynamic-key-after-member.mjs", `const field = "displayName"; const value = { public: true, [field]: "ordinary" };\n`],
]) {
  test(`candidate v7 mutation rejects ${label}`, async () => {
    const repo = await disposableRepo(singleFile(path, content));
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate|computed.*key|scanner.*bound/i);
  });
}

const executableUnsafeCases = [
  ["extensionless URL", "run", `#!/bin/sh\nhttps://example.invalid; password=${hostileValue("H")}\n`],
  ["mid-word URL fragment", "run", `#!/bin/sh\nurl=https://example.invalid/#fragment; password=${hostileValue("F")}\n`],
  ["line comment", "run", `#!/bin/sh\n# password=${hostileValue("C")}\n`],
  ["blank-delimited comment", "run", `#!/bin/sh\nprintf safe # password=${hostileValue("B")}\n`],
  ["semicolon comment", "run", `#!/bin/sh\n:;# password=${hostileValue("S")}\n`],
  ["escaped semicolon", "run", `#!/bin/sh\nmarker=foo\\;#fragment; password=${hostileValue("E")}\n`],
  ["escaped blank", "run", `#!/bin/sh\nmarker=foo\\ #fragment; password=${hostileValue("W")}\n`],
  ["escaped ampersand", "run", `#!/bin/sh\nmarker=foo\\&#fragment; password=${hostileValue("A")}\n`],
  ["backslash newline", "run", `#!/bin/sh\nmarker=foo\\\n#fragment; password=${hostileValue("L")}\n`],
  ["direct command substitution", "run", `#!/bin/sh\nmarker=$(printf foo)#fragment; password=${hostileValue("D")}\n`],
  ["prefixed command substitution", "run", `#!/bin/sh\nmarker=pre$(printf foo)#fragment; password=${hostileValue("P")}\n`],
  ["nested command substitution", "run", `#!/bin/sh\nmarker=$(printf %s $(printf foo))#fragment; password=${hostileValue("N")}\n`],
  ["arithmetic substitution", "run", `#!/bin/sh\nmarker=$((1 + 1))#fragment; password=${hostileValue("R")}\n`],
  ["quoted hash adjacency", "run", `#!/bin/sh\nmarker=\"$(printf safe)#fragment\"; password=${hostileValue("Q")}\n`],
  ...["sh", "bash", "dash", "ksh", "zsh"].map((extension) => [`.${extension} extension comment`, `script.${extension}`, `# password=${hostileValue("X")}\n`]),
  ...[
    ["direct sh", "#!/bin/sh"],
    ["direct bash", "#!/usr/local/bin/bash -e"],
    ["direct dash", "#!/bin/dash"],
    ["direct ksh", "#!/opt/tools/ksh"],
    ["direct zsh", "#!/usr/bin/zsh"],
    ["env sh", "#!/usr/bin/env sh"],
    ["env bash option", "#!/usr/bin/env -i bash"],
    ["env split", "#!/usr/bin/env -S dash -eu"],
    ["env unset split", "#!/usr/bin/env --unset HOME ksh"],
    ["env chdir equals", "#!/usr/bin/env --chdir=/tmp zsh"],
    ["GNU env split-string equals", "#!/usr/bin/env --split-string=sh -eu"],
    ["GNU env attached unset", "#!/usr/bin/env -S -uHOME sh"],
    ["GNU env attached chdir", "#!/usr/bin/env -S -C/tmp sh"],
    ["GNU env attached split", "#!/usr/bin/env -Ssh -eu"],
    ["Python shebang", "#!/usr/bin/env python3"],
    ["arbitrary interpreter", "#!/opt/tools/arbitrary --flag"],
    ["malformed bare shebang", "#!"],
    ["bare env", "#!env bash"],
  ].map(([label, shebang]) => [label, `exec-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, `${shebang}\n# password=${hostileValue("V")}\n`]),
];

test("Concord consolidated executable-text matrix rejects every unsafe sensitive assignment comment-blind", async () => {
  const accepted = [];
  for (const [label, path, content] of executableUnsafeCases) {
    const repo = await disposableRepo(singleFile(path, content));
    try {
      await buildCandidateManifest(repo);
      accepted.push(label);
    } catch (error) {
      assert.match(error.message, /secret-like value policy.*candidate/i, label);
      assert.equal(error.message.includes(hostileValue("V")), false, `${label} leaked assignment bytes`);
    }
  }
  assert.deepEqual(accepted, [], `scanner accepted ${accepted.length} executable-text bypasses`);
});

test("Concord consolidated executable-text diagnostics do not leak rejected assignment bytes", async () => {
  const rejectedValue = "DO_NOT_ECHO_THIS_ASSIGNMENT_VALUE_7429";
  const repo = await disposableRepo({ run: `#!/usr/bin/python3\n# password=${rejectedValue}\n` });
  await assert.rejects(
    buildCandidateManifest(repo),
    (error) => /secret-like value policy.*candidate/i.test(error.message) && !error.message.includes(rejectedValue),
  );
});

test("Concord consolidated executable-text lane permits exact placeholders even after hash characters", async () => {
  const files = {
    "placeholder-comment.sh": "# password=<redacted>\n",
    "placeholder-inline.bash": "printf safe # token=REPLACE_WITH_SECRET\n",
    "placeholder-python": "#!/usr/bin/python3\n# client_secret=EXAMPLE_ONLY_CHANGE_ME\n",
    "placeholder-arbitrary": "#!/some/arbitrary/interpreter\n# database_url=<provided-by-secret-manager>\n",
  };
  await buildCandidateManifest(await disposableRepo(files));
});

test("Concord consolidated executable-text lane preserves harmless hash syntax and substitutions", async () => {
  const files = {
    "quoted-hashes.sh": "single='#public'; double=\"#public\"\nprintf '%s' \"$single$double\"\n",
    "escaped-hash.bash": "value=\\#public\nprintf '%s' \"$value\"\n",
    "url-fragment.dash": "url=https://example.invalid/#fragment\nprintf '%s' \"$url\"\n",
    "parameter-trim.ksh": "value=prefixpublic\ntrimmed=${value#prefix}\nprintf '%s' \"$trimmed\"\n",
    "substitutions.zsh": "one=$(printf safe)\ntwo=pre$(printf safe)\nthree=$(printf %s $(printf safe))\nfour=$((1 + 1))\n",
  };
  await buildCandidateManifest(await disposableRepo(files));
});

test("Concord executable-text lane permits only exact simple shell variable references", async () => {
  for (const [index, rhs] of ["$NAME", "${NAME}", '"$NAME"', '"${NAME}"'].entries()) {
    const path = `accepted-${index}.sh`;
    await buildCandidateManifest(await disposableRepo(singleFile(path, `#!/bin/sh\npassword=${rhs}\n`)));
  }
});

test("Concord executable-text lane rejects every non-exact shell expression without suppression or diagnostic leakage", async () => {
  const rejected = [
    "'$NAME'", "'${NAME}'", "$(printf unsafe)", "$((1 + 1))", "literal", '"literal"',
    "prefix$NAME", "$NAME-suffix", "${NAME}suffix", "${NAME:-fallback}", "${!NAME}",
    "$NAME${OTHER}", '"$NAME suffix"', '"$NAME$(printf unsafe)"', "$1",
  ];
  for (const [index, rhs] of rejected.entries()) {
    const canary = `DO_NOT_LEAK_SHELL_MATRIX_${index}`;
    const repo = await disposableRepo(singleFile(`rejected-${index}.sh`, `#!/bin/sh\n# password=${rhs}\nmarker=${canary}\n`));
    await assert.rejects(buildCandidateManifest(repo), (error) => (
      /secret-like value policy.*candidate/i.test(error.message) && !error.message.includes(canary)
    ), rhs);
  }
});

test("Concord executable-text comments remain non-suppressing while exact variable references remain admissible", async () => {
  await buildCandidateManifest(await disposableRepo(singleFile("safe-comment.sh", "#!/bin/sh\n# password=$RUNTIME_MATERIAL\n")));
  const repo = await disposableRepo(singleFile("unsafe-comment.sh", "#!/bin/sh\n# password='not-runtime-material'\n"));
  await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
});

test("unknown extensionless text retains conservative hash-comment behavior", async () => {
  const repo = await disposableRepo({ notes: `# password=${hostileValue("C")}\npublic=true\n` });
  await buildCandidateManifest(repo);
});

test("Concord consolidated scanner bounds executable-text nesting", async () => {
  const nesting = 8_193;
  const content = `#!/bin/sh\nmarker=${"$(".repeat(nesting)}printf foo${")".repeat(nesting)}\n`;
  const repo = await disposableRepo({ run: content });
  const started = performance.now();
  await assert.rejects(buildCandidateManifest(repo), /scanner nesting bound exceeded: 8192/i);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3_000, `executable-text scanner exceeded bounded threshold: ${elapsed.toFixed(1)}ms`);
});

test("candidate accepts CSS, executable text, generic text, and static-computed safe controls", async () => {
  const repo = await disposableRepo({
    "safe.css": [
      '.password:focus, .token[data-kind="public"] { color: var(--accent); }',
      String.raw`:root { --display\2d name: ${hostileValue("D")}; }`,
      ":root { --api-token: /* runtime */ <redacted>; }",
      "",
    ].join("\n"),
    "safe-shell": "#!/bin/sh\nprintf '%s\\n' https://example.invalid/path//segment # public URL\n",
    "safe-text": "documentation URL: https://example.invalid/path//segment\npublic=true\n",
    "safe-computed.mjs": [
      `const value = { [\`display\${("Na" + "me")}\`]: "${hostileValue("K")}" };`,
      `const nested = { [\`display\${\`Na\${"me"}\`}\`]: "${hostileValue("M")}" };`,
      "const field = getRuntimeField(); target[field] = runtime.value;",
      "",
    ].join("\n"),
    "db/migrations/001_safe.sql": `-- password = '${hostileValue("S")}'\nSELECT 1;\n`,
    "safe.yaml": `# password: ${hostileValue("Y")}\npublic: true\n`,
  });
  await buildCandidateManifest(repo);
});

test("candidate v7 CSS normalization and escape decoding stay bounded", async () => {
  const comments = "/**/".repeat(20_000);
  const repo = await disposableRepo({
    "bounded.css": `:root { ${comments}--display\\2d name: public; }\n`,
  });
  const started = performance.now();
  await buildCandidateManifest(repo);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3_000, `CSS scanner exceeded bounded threshold: ${elapsed.toFixed(1)}ms`);

  const oversized = await disposableRepo({
    "oversized-escape.css": `:root { --${String.raw`\61 `.repeat(1025)}: public; }\n`,
  });
  await assert.rejects(buildCandidateManifest(oversized), /custom-property|CSS|name|bound|secret-like value policy/i);
});

test("candidate scanner completes 16k nested-bracket stress within a bounded threshold", async () => {
  const nesting = 16_000;
  const content = `${"[".repeat(nesting)}"display"${"]: value;".repeat(nesting)}\n`;
  const repo = await disposableRepo({ "nested-stress.mjs": content });
  const started = performance.now();
  await assert.rejects(buildCandidateManifest(repo), /scanner.*bound|nesting|token|delimiter/i);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3_000, `scanner exceeded bounded threshold: ${elapsed.toFixed(1)}ms`);
});

test("credential prefixes and private keys are rejected even inside comments", async () => {
  for (const content of [
    `# token example: ${["gh", "p_"].join("")}${hostileValue("A")}\n`,
    `/* ${["-----BEGIN", " PRIVATE KEY-----"].join("")} */\n`,
  ]) {
    const repo = await disposableRepo({ "comment.txt": content });
    await assert.rejects(buildCandidateManifest(repo), /secret-like value policy.*candidate/i);
  }
});

test("only explicit raster, font, and model source assets may remain opaque binary", async () => {
  const binary = Buffer.from([0, 0xff, 0x80, 0x01]);
  const repo = await disposableRepo({
    "assets/badges/mark.png": binary,
    "assets/fonts/display.woff2": binary,
    "assets/models/item.glb": binary,
  });
  const manifest = await buildCandidateManifest(repo);
  assert.equal(manifest.files.length, 3);
});

test("unapproved opaque binary fails closed", async () => {
  const repo = await disposableRepo({ "assets/data.bin": Buffer.from([0, 0xff, 0x80, 0x01]) });
  await assert.rejects(buildCandidateManifest(repo), /NUL|UTF-8|opaque|binary|text/i);
});
