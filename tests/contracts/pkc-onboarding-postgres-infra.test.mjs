import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluateCapacity } from "../../ops/pkc-onboarding-postgres/scripts/check-capacity.mjs";
import { attestEmptyRestoreTarget } from "../../ops/pkc-onboarding-postgres/scripts/preflight-restore-target.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const scope = path.join(root, "ops", "pkc-onboarding-postgres");
const read = (relative) => readFileSync(path.join(scope, relative), "utf8");
const run = (runtime, relative, args = []) => spawnSync(runtime, [path.join(scope, relative), ...args], { cwd: root, encoding: "utf8" });
const temporaryRoots = new Set();
const temporaryRoot = (prefix) => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
};
test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});
const jsonFile = (directory, name, value) => {
  const target = path.join(directory, name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
};

const image = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const privateNetwork = "pkc_onboarding_private";

function validReceipt() {
  return {
    schema_version: 1,
    compose_project: "pkc-onboarding-postgres",
    service: "postgres",
    image,
    volume: "pkc_onboarding_postgres_data",
    private_dns: "pkc-postgres",
    database: "pkc_founder_mfa",
    environment: "production",
    postgres_major: 16,
    system_identifier: "1234567890123456789",
    tls: { enabled: true, minimum_protocol: "TLSv1.3", client_certificate_verification: "verify-full", server_name: "pkc-postgres" },
    durability: { fsync: true, synchronous_commit: "on", full_page_writes: true, data_checksums: true }
  };
}

function rootRendered() {
  return {
    name: "root",
    services: {
      n8n: {
        image: "n8nio/n8n@sha256:fixture",
        environment: { N8N_DIAGNOSTICS_ENABLED: "false" },
        networks: { root_default: null },
        volumes: [{ type: "volume", source: "n8n_data", target: "/home/node/.n8n" }]
      }
    },
    networks: { root_default: { name: "root_default" } },
    volumes: { n8n_data: { name: "root_n8n_data" } }
  };
}

function candidateRootRendered() {
  const value = structuredClone(rootRendered());
  value.services.n8n.networks[privateNetwork] = null;
  value.networks[privateNetwork] = { name: privateNetwork, external: true };
  return value;
}

function postgresRendered() {
  return {
    name: "pkc-onboarding-postgres",
    services: {
      postgres: {
        image,
        networks: { pkc_private: { aliases: ["pkc-postgres"] } },
        volumes: [{ type: "volume", source: "postgres_data", target: "/var/lib/postgresql/data" }]
      }
    },
    networks: { pkc_private: { name: privateNetwork, internal: true } }
  };
}

test("Compose contract is private, pinned, bounded, durable, and secret-file based", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /^name: pkc-onboarding-postgres$/m);
  assert.match(compose, new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(compose, /internal: true/);
  assert.match(compose, /name: pkc_onboarding_private/);
  assert.match(compose, /pkc_onboarding_postgres_data/);
  assert.match(compose, /cpus: "0\.75"/);
  assert.match(compose, /mem_limit: 768m/);
  assert.match(compose, /pids_limit: 200/);
  assert.match(compose, /shm_size: 128m/);
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /max-file: "3"/);
  assert.match(compose, /stop_grace_period: 60s/);
  const healthcheck = compose.match(/    healthcheck:\n((?:      .*\n)+)/)?.[0] ?? "";
  assert.match(healthcheck, /pg_isready/);
  assert.doesNotMatch(healthcheck, /password|PGPASSWORD/i);
  assert.match(compose, /POSTGRES_DB: pkc_founder_mfa/);
  assert.match(compose, /POSTGRES_USER: pkc_bootstrap_admin/);
  const bootstrapFileSetting = new RegExp(`POSTGRES_${"PASSWORD"}_FILE:\\s*\\/run\\/secrets\\/pkc_bootstrap_auth_file`);
  assert.match(compose, bootstrapFileSetting);
  assert.match(compose, /POSTGRES_INITDB_ARGS:\s*--data-checksums --auth-host=scram-sha-256 --auth-local=scram-sha-256/);
  assert.doesNotMatch(compose, new RegExp(`POSTGRES_${"PASSWORD"}:`));
  assert.match(compose, /pkc-postgres-entrypoint\.sh/);
  const entrypoint = read("scripts/pkc-postgres-entrypoint.sh");
  assert.match(entrypoint, /chown postgres:postgres "\$stage"/);
  assert.match(entrypoint, /chmod 0700 "\$stage"/);
  assert.match(entrypoint, /chmod 0600 .*server\.key/);
  assert.match(entrypoint, /chown postgres:postgres/);
  assert.match(entrypoint, /exec \/usr\/local\/bin\/docker-entrypoint\.sh/);
});

test("TLS and client connection contracts require mutual TLS and credential-free DSNs", () => {
  const postgres = read("config/postgresql.conf");
  const hba = read("config/pg_hba.conf");
  const client = read("client-connection.env.example");
  assert.match(postgres, /^ssl = on$/m);
  assert.match(postgres, /^ssl_min_protocol_version = 'TLSv1\.3'$/m);
  assert.match(postgres, /ssl_ca_file = '\/var\/run\/postgresql\/pkc-tls\/client-ca\.crt'/);
  assert.match(hba, /^local\s+all\s+all\s+scram-sha-256$/m);
  assert.match(hba, /^hostssl\s+all\s+all\s+0\.0\.0\.0\/0\s+scram-sha-256\s+clientcert=verify-full$/m);
  assert.match(hba, /^hostssl\s+all\s+all\s+::\/0\s+scram-sha-256\s+clientcert=verify-full$/m);
  assert.doesNotMatch(hba, /^host(?!ssl)/m);
  assert.match(client, /strict verify-full mode/);
  assert.match(client, /CA, client certificate, private key, and PGPASS paths/);
  const databaseUrlPattern = new RegExp("^PKC_DATABASE_" + "URL=<provided-by-secret-manager>$", "m");
  assert.match(client, databaseUrlPattern);
  assert.match(client, /^PGPASSFILE=\$\{PKC_ROLE_PGPASSFILE\}$/m);
  const loader = read("../../db/client-authority.mjs");
  for (const parameter of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    assert.match(loader, new RegExp(parameter));
  assert.match(client, /pkc_founder_mfa/);
  for (const role of ["pkc_bootstrap_admin", "pkc_backup_reader", "pkc_mfa_migrator", "pkc_mfa_verifier", "pkc_onboarding_runtime", "pkc_onboarding_email_worker", "pkc_onboarding_email_reconciler"])
    assert.match(client, new RegExp(role));
  assert.doesNotMatch(client, /:\/\/[^\s:@/]+:[^\s@/]+@/);
  for (const fixture of ["fixtures/tls/server.crt.fixture", "fixtures/tls/server.key.fixture", "fixtures/tls/client-ca.crt.fixture"]) {
    const text = read(fixture);
    assert.match(text, /^FIXTURE_ONLY_NOT_A_REAL_/);
    assert.doesNotMatch(text, /-----BEGIN (?:CERTIFICATE|PRIVATE KEY)-----/);
  }
});

test("secret validator uses one no-follow descriptor and rejects hostile schema drift", () => {
  const source = read("scripts/validate-secrets.py");
  assert.match(source, /os\.O_NOFOLLOW/);
  assert.match(source, /os\.fstat/);
  assert.match(source, /\/dev\/fd/);
  assert.doesNotMatch(source, /Path\([^)]*\)\.read_text|open\([^)]*path/);

  const dir = temporaryRoot("pkc-secrets-");
  const openssl = (...args) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=server-ca", "-keyout", "server-ca.key", "-out", "postgres_server_ca");
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=client-ca", "-keyout", "client-ca.key", "-out", "postgres_client_ca");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=pkc-postgres", "-keyout", "postgres_server_key", "-out", "server.csr");
  openssl("x509", "-req", "-days", "30", "-in", "server.csr", "-CA", "postgres_server_ca", "-CAkey", "server-ca.key", "-CAcreateserial", "-out", "postgres_server_cert");
  writeFileSync(path.join(dir, "postgres_bootstrap_password"), `${"A".repeat(48)}\n`, { mode: 0o600 });
  for (const name of ["postgres_bootstrap_password", "postgres_server_cert", "postgres_server_key", "postgres_server_ca", "postgres_client_ca"])
    chmodSync(path.join(dir, name), 0o600);
  for (const residue of ["server-ca.key", "client-ca.key", "server.csr", "postgres_server_ca.srl"])
    rmSync(path.join(dir, residue), { force: true });
  assert.equal(run("python3", "scripts/validate-secrets.py", [dir]).status, 0);
  const descriptorProbe = path.join(dir, "descriptor-probe.crt");
  writeFileSync(descriptorProbe, readFileSync(path.join(dir, "postgres_server_cert")), { mode: 0o600 });
  const descriptorFallback = spawnSync("python3", ["-c", `
import importlib.util
import os
import sys

module_path, certificate_path = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("pkc_validate_secrets", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
descriptor = os.open(certificate_path, os.O_RDONLY | os.O_NOFOLLOW)
os.unlink(certificate_path)
while os.read(descriptor, 65536):
    pass
original_isdir = module.os.path.isdir
module.os.path.isdir = lambda candidate: candidate == "/dev/fd"
try:
    selected = module.descriptor_path(descriptor)
    if selected != f"/dev/fd/{descriptor}":
        raise RuntimeError("unexpected_descriptor_path")
    module.run_openssl(["x509", "-in", selected, "-noout"], [descriptor])
finally:
    module.os.path.isdir = original_isdir
    os.close(descriptor)
print("dev_fd_inherited_descriptor_valid=true")
`, path.join(scope, "scripts", "validate-secrets.py"), descriptorProbe], { cwd: root, encoding: "utf8" });
  assert.equal(descriptorFallback.status, 0, descriptorFallback.stderr);
  assert.match(descriptorFallback.stdout, /dev_fd_inherited_descriptor_valid=true/);
  assert.equal(existsSync(descriptorProbe), false);
  writeFileSync(path.join(dir, "unexpected"), "x\n", { mode: 0o600 });
  const extra = run("python3", "scripts/validate-secrets.py", [dir]);
  assert.notEqual(extra.status, 0);
  assert.doesNotMatch(`${extra.stdout}${extra.stderr}`, /A{12}|B{12}/);
  const serverSchema = JSON.parse(read("contracts/secret-files.schema.json"));
  assert.deepEqual(serverSchema.required, ["bootstrap_auth_file", "tls_server_certificate", "tls_server_key", "tls_server_ca", "tls_client_ca"]);
  const clientSchema = JSON.parse(read("contracts/client-secret-files.schema.json"));
  assert.deepEqual(clientSchema.properties.role.enum, ["pkc_bootstrap_admin", "pkc_backup_reader", "pkc_mfa_migrator", "pkc_mfa_verifier", "pkc_onboarding_runtime", "pkc_onboarding_email_worker", "pkc_onboarding_email_reconciler"]);
  assert.equal(clientSchema.additionalProperties, false);
});

test("rendered Compose verifier preserves n8n SQLite authority and network isolation", () => {
  const dir = temporaryRoot("pkc-compose-");
  const baseline = jsonFile(dir, "baseline.json", rootRendered());
  const candidate = jsonFile(dir, "candidate.json", candidateRootRendered());
  const postgres = jsonFile(dir, "postgres.json", postgresRendered());
  assert.equal(run("node", "scripts/verify-rendered-compose.mjs", [baseline, candidate, postgres]).status, 0);

  const drift = candidateRootRendered();
  drift.services.n8n.environment.DB_TYPE = "postgresdb";
  const bad = jsonFile(dir, "bad.json", drift);
  assert.notEqual(run("node", "scripts/verify-rendered-compose.mjs", [baseline, bad, postgres]).status, 0);

  const joined = postgresRendered();
  joined.services.postgres.networks.root_default = null;
  const badPg = jsonFile(dir, "bad-pg.json", joined);
  assert.notEqual(run("node", "scripts/verify-rendered-compose.mjs", [baseline, candidate, badPg]).status, 0);
});

test("cluster identity receipt validator enforces every exact identity and durability field", () => {
  const dir = temporaryRoot("pkc-receipt-");
  const valid = jsonFile(dir, "valid.json", validReceipt());
  assert.equal(run("node", "scripts/validate-cluster-receipt.mjs", [valid]).status, 0);
  for (const mutate of [
    (r) => { r.image = "postgres:16-alpine"; },
    (r) => { delete r.system_identifier; },
    (r) => { r.tls.client_certificate_verification = "require"; },
    (r) => { r.durability.fsync = false; }
  ]) {
    const receipt = validReceipt(); mutate(receipt);
    const bad = jsonFile(dir, `bad-${Math.random()}.json`, receipt);
    assert.notEqual(run("node", "scripts/validate-cluster-receipt.mjs", [bad]).status, 0);
  }
});

test("backup receipt validator rejects a two-link completion marker", () => {
  const dir = temporaryRoot("pkc-backup-receipt-links-");
  const artifactName = "pkc-onboarding-20261002T041500Z.dump.age";
  const artifact = path.join(dir, artifactName);
  const checksum = `${artifact}.sha256`;
  const receipt = `${artifact}.receipt.json`;
  const sourceReceipt = path.join(dir, "cluster-identity.receipt.json");
  const artifactBytes = Buffer.from("encrypted-artifact-fixture\n");
  const artifactSha = createHash("sha256").update(artifactBytes).digest("hex");
  const sourceBytes = Buffer.from(`${JSON.stringify(validReceipt())}\n`);
  const backupReceipt = Buffer.from(`${JSON.stringify({
    artifact: artifactName,
    artifactSha256: artifactSha,
    createdAt: "20261002T041500Z",
    schema: "pkc-encrypted-backup-receipt-v1",
    sourceReceiptSha256: createHash("sha256").update(sourceBytes).digest("hex")
  })}\n`);
  for (const [file, bytes] of [[artifact, artifactBytes], [checksum, Buffer.from(`${artifactSha}  ${artifactName}\n`)], [receipt, backupReceipt], [sourceReceipt, sourceBytes]]) {
    writeFileSync(file, bytes, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  assert.equal(run("node", "scripts/validate-backup-receipt.mjs", [artifact, checksum, receipt, sourceReceipt]).status, 0);
  linkSync(receipt, path.join(dir, "receipt-second-link.json"));
  assert.equal(lstatSync(receipt).nlink, 2);
  assert.notEqual(run("node", "scripts/validate-backup-receipt.mjs", [artifact, checksum, receipt, sourceReceipt]).status, 0);
});

test("capacity gate requires current use below 80 percent and bounded projected headroom", () => {
  const request = {
    schema_version: 2,
    cpu: { requested_cores: 0.75, reserve_cores: 0.5 },
    memory: { requested_mib: 768, reserve_mib: 1024 },
    disk: { requested_mib: 8192, reserve_mib: 10240, inode_reserve: 100000 }
  };
  const metrics = {
    cpu: { availableCores: 4, oneMinuteLoad: 1 },
    memory: { availableMiB: 4096 },
    disk: { capacityBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3, inodeCapacity: 1000000, inodeAvailable: 800000 }
  };
  assert.equal(evaluateCapacity(request, metrics).ready, true);
  for (const hostile of [
    { ...metrics, memory: { availableMiB: 1000 } },
    { ...metrics, disk: { ...metrics.disk, availableBytes: 20 * 1024 ** 3 } },
    { ...metrics, disk: { ...metrics.disk, availableBytes: 30 * 1024 ** 3 } },
    { ...metrics, disk: { ...metrics.disk, inodeAvailable: 100000 } },
    { ...metrics, cpu: { availableCores: 1, oneMinuteLoad: 1 } }
  ]) assert.throws(() => evaluateCapacity(request, hostile), /capacity_gate_failed/);
  assert.throws(() => evaluateCapacity({ ...request, disk: { ...request.disk, inode_reserve: 0 } }, metrics), /capacity_gate_failed/);
  const busyButSufficient = { ...metrics, cpu: { ...metrics.cpu, oneMinuteLoad: 99 } };
  assert.equal(evaluateCapacity(request, busyButSufficient).oneMinuteLoad, 99);
});

test("backup, restore drill, and exact-label cleanup scripts fail closed", async () => {
  const backup = read("scripts/backup-encrypted.sh");
  const restore = read("scripts/restore-drill.sh");
  const decrypt = read("scripts/decrypt-validated-backup.mjs");
  const nativeRestore = readFileSync(path.join(root, "scripts", "test-pkc-restore-postgres.sh"), "utf8");
  const cleanup = read("scripts/cleanup-exact-labels.sh");
  for (const source of [backup, restore]) {
    assert.match(source, /PGPASSFILE/);
    assert.doesNotMatch(source, /PGPASSWORD|:\/\/[^\s:@/]+:[^\s@/]+@|--password(?:=|\s)/);
  }
  assert.match(backup, /pg_dump/);
  assert.match(backup, /pg_dump major 16 required/);
  assert.match(backup, /--schema=pkc_auth/);
  assert.doesNotMatch(backup, /--no-privileges/);
  assert.match(backup, /age --encrypt --recipients-file/);
  assert.match(backup, /validate-client-authority\.mjs/);
  assert.match(backup, /validate-cluster-receipt\.mjs/);
  assert.match(backup, /--verifier-dsn/);
  assert.match(backup, /--verifier-pgpass-file/);
  assert.match(backup, /attest-backup-source\.mjs/);
  assert.ok(backup.indexOf("validate-cluster-receipt.mjs") < backup.indexOf("attest-backup-source.mjs"));
  assert.ok(backup.indexOf("attest-backup-source.mjs") < backup.indexOf("stamp="));
  assert.ok(backup.indexOf("attest-backup-source.mjs") < backup.indexOf("pg_dump --format=custom"));
  assert.match(backup, /ln -- "\$temporary" "\$final"/);
  assert.doesNotMatch(backup, /mv -n/);
  assert.match(restore, /PKC_RESTORE_DRILL_ISOLATED/);
  assert.match(restore, /pg_restore major 16 required/);
  assert.match(restore, /pkc_founder_mfa_restore_drill/);
  assert.match(restore, /decrypt-validated-backup\.mjs/);
  assert.match(decrypt, /spawnSync\("age"/);
  assert.match(decrypt, /O_NOFOLLOW/);
  assert.match(decrypt, /stdio: \[artifact\.fd, "inherit"/);
  assert.match(decrypt, /expected-set-proof/);
  assert.match(decrypt, /validateBackupReceiptBytes/);
  assert.doesNotMatch(restore, /mktemp|backup\.dump|rm -rf/);
  assert.match(nativeRestore, /docker exec -i .* pg_restore/);
  assert.doesNotMatch(nativeRestore, /pkc-restore\.dump|docker cp \"\$archive\"|dd of=\"\$archive\"/);
  assert.match(restore, /preflight-restore-target\.mjs/);
  assert.ok(restore.indexOf("decrypt-validated-backup.mjs") < restore.indexOf("preflight-restore-target.mjs"));
  assert.ok(restore.indexOf("preflight-restore-target.mjs") < restore.indexOf("pg_restore --exit-on-error"));
  assert.match(restore, /--expected-user pkc_bootstrap_admin/);
  assert.match(restore, /--role=pkc_mfa_owner/);
  assert.doesNotMatch(restore, /pg_restore[^\n]*--no-privileges/);
  assert.ok(restore.indexOf("pg_restore --exit-on-error") < restore.indexOf("004_onboarding_roles.sql"));
  assert.ok(restore.indexOf("004_onboarding_roles.sql") < restore.indexOf("006_backup_reader.sql"));
  assert.ok(restore.indexOf("006_backup_reader.sql") < restore.indexOf("010_seal_migrator.sql"));
  assert.match(restore, /--expected-user pkc_mfa_verifier/);
  assert.match(restore, /db\/readiness\.mjs/);
  assert.match(restore, /restore_content_verified=true/);
  assert.match(restore, /restore_target_identity_verified_before_mutation=true/);
  assert.match(restore, /restore_runtime_authority_sealed=true/);
  assert.match(restore, /restore_resource_isolation_requires_operator_receipt=true/);
  assert.doesNotMatch(restore, /isolated restore drill passed/);
  await assert.rejects(() => attestEmptyRestoreTarget({
    connectionString: "postgresql://pkc_bootstrap_admin@127.0.0.1:5432/pkc_founder_mfa?sslmode=verify-full&sslrootcert=/tmp/ca&sslcert=/tmp/cert&sslkey=/tmp/key&application_name=pkc_founder_mfa_restore_drill",
    pgpassFile: "/tmp/pgpass",
    sourceReceiptPath: "/tmp/source-receipt",
    expectedSystemIdentifier: "1234567890123456",
    expectedServerAddress: "127.0.0.1",
    expectedServerPort: 5432,
    expectedDatabase: "pkc_founder_mfa_restore_drill",
    expectedUser: "pkc_bootstrap_admin",
  }), /restore_target_preflight_failed/);
  assert.match(cleanup, /com\.docker\.compose\.project=pkc-onboarding-postgres/);
  assert.match(cleanup, /com\.docker\.compose\.service=postgres/);
  assert.match(cleanup, /com\.docker\.compose\.network=pkc_private/);
  assert.match(cleanup, /Docker inventory failed/);
  assert.match(cleanup, /remaining_containers/);
  assert.match(cleanup, /--execute/);
  assert.match(cleanup, /preserved_volume=/);
  assert.doesNotMatch(cleanup, /docker\s+volume\s+(?:rm|prune)|docker\s+compose[^\n]*\s-v(?:\s|$)/);
  assert.notEqual(run("bash", "scripts/backup-encrypted.sh").status, 0);
  assert.notEqual(run("bash", "scripts/restore-drill.sh").status, 0);
  const fakeBin = temporaryRoot("pkc-fake-docker-");
  const fakeDocker = path.join(fakeBin, "docker");
  const dockerLog = path.join(fakeBin, "calls.log");
  writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PKC_DOCKER_LOG"\ncase "$*" in\n  "ps -aq"*) exit 0 ;;\n  "network ls -q"*) exit 0 ;;\n  "volume ls -q"*) printf '%s\\n' pkc_onboarding_postgres_data ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(fakeDocker, 0o755);
  const cleanupResult = spawnSync("bash", [path.join(scope, "scripts/cleanup-exact-labels.sh")], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PKC_DOCKER_LOG: dockerLog } });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.match(readFileSync(dockerLog, "utf8"), /com\.docker\.compose\.network=pkc_private/);
});

test("A1of1 publisher is descriptor-bound, receipt-last, idempotent, and collision closed", () => {
  const wrapper = read("scripts/publish-a1of1-backup.sh");
  const publisher = read("scripts/publish-a1of1-backup.mjs");
  const remote = read("scripts/publish-a1of1-remote.py");
  assert.match(wrapper, /exec node .*publish-a1of1-backup\.mjs/);
  for (const token of ["const REMOTE_ALIAS = \"a1of1\"", "const REMOTE_OWNER = \"aiel\"", "/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres", "O_NOFOLLOW", "process.geteuid", "validateBackupReceiptBytes", "validateClusterReceiptBytes"])
    assert.match(publisher, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no"])
    assert.match(publisher, new RegExp(option));
  assert.match(publisher, /stdio: \[inputFd === null \? "ignore" : inputFd/);
  assert.doesNotMatch(publisher, /--host|--remote-root|--destination|\bscp\b|\brsync\b|pg_dump|pg_restore|psql|PGPASSFILE|age --decrypt/);
  for (const token of ["dir_fd=", "os.O_NOFOLLOW", "os.fstat", "revalidate_chain", "FileVault is On.", "follow_symlinks=False"])
    assert.match(remote, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(remote, /test_mode\s*=.*owner\s*!=\s*["']aiel["']/);
  assert.ok(remote.lastIndexOf("cleanup_stage(staging_fd, receipts_fd, nonce, uid)") < remote.lastIndexOf("publish_receipt_no_replace(receipts_fd"));
  assert.match(remote, /publish_receipt_no_replace\(receipts_fd, temp_read, temp_name, custody_name\)/);
  const commitFunction = remote.slice(remote.indexOf("def publish_receipt_no_replace"), remote.indexOf("def main"));
  assert.doesNotMatch(commitFunction, /os\.open\(temp_name/);
  assert.match(remote, /fclonefileat/);
  assert.match(remote, /AT_EMPTY_PATH|0x1000/);
  assert.doesNotMatch(remote, /renameatx_np|os\.rename\(temp_name/);
  assert.doesNotMatch(remote, /pg_dump|pg_restore|psql|age --decrypt|PGPASSFILE/);
  assert.notEqual(run("bash", "scripts/publish-a1of1-backup.sh").status, 0);

  const a1of1TestRoot = (prefix) => {
    const base = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    const candidate = mkdtempSync(path.join(base, prefix));
    temporaryRoots.add(candidate);
    return candidate;
  };
  const directory = a1of1TestRoot("pkc-a1of1-remote-test-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(directory, name), { mode: 0o700 });
  chmodSync(directory, 0o700);
  const owner = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  assert.ok(owner.length > 0);
  const artifactName = "pkc-onboarding-20261002T031700Z.dump.age";
  const artifactBytes = Buffer.from("ciphertext-only-fixture\n");
  const artifactSha = createHash("sha256").update(artifactBytes).digest("hex");
  const checksumBytes = Buffer.from(`${artifactSha}  ${artifactName}\n`);
  const receiptBytes = Buffer.from('{"schema":"pkc-encrypted-backup-receipt-v1"}\n');
  const sourceReceiptBytes = Buffer.from('{"schema":"pkc-postgres-cluster-identity-v1"}\n');
  const checksumSha = createHash("sha256").update(checksumBytes).digest("hex");
  const receiptSha = createHash("sha256").update(receiptBytes).digest("hex");
  const sourceReceiptSha = createHash("sha256").update(sourceReceiptBytes).digest("hex");
  const helper = path.join(scope, "scripts", "publish-a1of1-remote.py");
  const env = { ...process.env, PKC_A1OF1_REMOTE_TEST_MODE: "1" };
  const invoke = (root, nonce, mode, args = [], input) => spawnSync("python3", [helper, mode, root, owner, artifactName, artifactSha, nonce, ...args], { encoding: "utf8", env, input });
  const invokeAs = (root, nonce, requestedOwner, requestedEnv) => spawnSync("python3", [helper, "preflight", root, requestedOwner, artifactName, artifactSha, nonce, String(artifactBytes.length)], { encoding: "utf8", env: requestedEnv });

  const noTestModeEnv = { ...process.env };
  delete noTestModeEnv.PKC_A1OF1_REMOTE_TEST_MODE;
  const missingTestModeNonce = "8".repeat(32);
  assert.notEqual(invokeAs(directory, missingTestModeNonce, owner, noTestModeEnv).status, 0);
  assert.equal(existsSync(path.join(directory, "staging", missingTestModeNonce)), false);
  const directMissingFlag = spawnSync("python3", ["-c", `
import importlib.util
import os
import sys

module_path, test_root, owner = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("pkc_publish_a1of1_remote", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
os.environ.pop("PKC_A1OF1_REMOTE_TEST_MODE", None)
try:
    _uid, descriptors, _records, _root_fd, _layout = module.open_layout(test_root, owner)
except RuntimeError:
    print("missing_test_mode_rejected=true")
else:
    for descriptor in reversed(descriptors):
        os.close(descriptor)
    raise RuntimeError("missing_test_mode_accepted")
`, helper, directory, owner], { encoding: "utf8", env: noTestModeEnv });
  assert.equal(directMissingFlag.status, 0, directMissingFlag.stderr);
  assert.match(directMissingFlag.stdout, /missing_test_mode_rejected=true/);

  const nonmatchingRoot = a1of1TestRoot("pkc-a1of1-invalid-root-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(nonmatchingRoot, name), { mode: 0o700 });
  chmodSync(nonmatchingRoot, 0o700);
  const nonmatchingNonce = "9".repeat(32);
  assert.notEqual(invokeAs(nonmatchingRoot, nonmatchingNonce, owner, env).status, 0);
  assert.equal(existsSync(path.join(nonmatchingRoot, "staging", nonmatchingNonce)), false);

  const alternateOwnerResult = spawnSync("python3", ["-c", "import os,pwd; print(next(entry.pw_name for entry in pwd.getpwall() if entry.pw_uid != os.geteuid()))"], { encoding: "utf8" });
  assert.equal(alternateOwnerResult.status, 0, alternateOwnerResult.stderr);
  const alternateOwner = alternateOwnerResult.stdout.trim();
  assert.ok(alternateOwner.length > 0 && alternateOwner !== owner);
  const mismatchedOwnerNonce = "a".repeat(32);
  assert.notEqual(invokeAs(directory, mismatchedOwnerNonce, alternateOwner, env).status, 0);
  assert.equal(existsSync(path.join(directory, "staging", mismatchedOwnerNonce)), false);

  const productionOwnerMismatch = owner === "aiel" ? alternateOwner : owner;
  assert.notEqual(invokeAs("/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres", "b".repeat(32), productionOwnerMismatch, env).status, 0);
  const stage = (root, nonce) => {
    const preflight = invoke(root, nonce, "preflight", [String(artifactBytes.length)]);
    assert.equal(preflight.status, 0, preflight.stderr);
    const layout = /layout_proof=([a-f0-9]{64})/.exec(preflight.stdout)?.[1];
    const staged = /stage_proof=([a-f0-9]{64})/.exec(preflight.stdout)?.[1];
    assert.ok(layout && staged);
    const tokens = [layout, staged];
    for (const [name, bytes, sha] of [["artifact", artifactBytes, artifactSha], ["checksum", checksumBytes, checksumSha], ["backup-receipt", receiptBytes, receiptSha], ["source-receipt", sourceReceiptBytes, sourceReceiptSha]]) {
      const received = invoke(root, nonce, "receive", [...tokens, name, sha], bytes);
      assert.equal(received.status, 0, received.stderr);
    }
    return { target: path.join(root, "staging", nonce), tokens };
  };
  const finalize = (root, nonce, tokens) => invoke(root, nonce, "finalize", [...tokens, checksumSha, receiptSha, sourceReceiptSha]);
  const cleanup = (root, nonce, tokens) => invoke(root, nonce, "cleanup", tokens);

  const firstNonce = "1".repeat(32);
  const firstStage = stage(directory, firstNonce);
  const first = finalize(directory, firstNonce, firstStage.tokens);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /a1of1_backup_published=true/);
  assert.match(first.stdout, /a1of1_idempotent=false/);
  const bundle = path.join(directory, "bundles", artifactSha);
  const receipt = path.join(directory, "receipts", `${artifactSha}.custody-receipt.json`);
  assert.deepEqual(readdirSync(bundle).sort(), [artifactName, `${artifactName}.sha256`].sort());
  assert.equal(createHash("sha256").update(readFileSync(path.join(bundle, artifactName))).digest("hex"), artifactSha);
  const custody = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(custody.schema, "pkc-a1of1-custody-receipt-v1");
  assert.equal(custody.artifactSha256, artifactSha);
  assert.equal(custody.backupReceiptSha256, receiptSha);
  assert.equal(custody.sourceReceiptSha256, sourceReceiptSha);
  assert.equal(custody.remoteHostAlias, "a1of1");
  assert.equal(custody.destinationRoot, directory);
  const publishedBackupReceipt = path.join(directory, "receipts", `${artifactSha}.backup-receipt.json`);
  assert.equal(createHash("sha256").update(readFileSync(publishedBackupReceipt)).digest("hex"), receiptSha);
  assert.equal(lstatSync(publishedBackupReceipt).nlink, 1);
  const publishedSourceReceipt = path.join(directory, "receipts", `${artifactSha}.source-receipt.json`);
  assert.equal(createHash("sha256").update(readFileSync(publishedSourceReceipt)).digest("hex"), sourceReceiptSha);
  assert.equal(lstatSync(publishedSourceReceipt).nlink, 1);
  assert.equal(lstatSync(path.join(bundle, artifactName)).nlink, 1);
  assert.equal(existsSync(path.join(directory, "staging", firstNonce)), false);

  const secondNonce = "2".repeat(32);
  const secondStage = stage(directory, secondNonce);
  const second = finalize(directory, secondNonce, secondStage.tokens);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /a1of1_idempotent=true/);
  assert.equal(existsSync(path.join(directory, "staging", secondNonce)), false);

  const hostileDirectory = a1of1TestRoot("pkc-a1of1-remote-test-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(hostileDirectory, name), { mode: 0o700 });
  chmodSync(hostileDirectory, 0o700);
  const hostileNonce = "3".repeat(32);
  const hostileStage = stage(hostileDirectory, hostileNonce);
  writeFileSync(path.join(hostileDirectory, "receipts", `${artifactSha}.custody-receipt.json`), receiptBytes, { mode: 0o600 });
  const hostile = finalize(hostileDirectory, hostileNonce, hostileStage.tokens);
  assert.notEqual(hostile.status, 0);
  assert.equal(existsSync(path.join(hostileDirectory, "bundles", artifactSha)), false);
  const cleaned = cleanup(hostileDirectory, hostileNonce, hostileStage.tokens);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(existsSync(hostileStage.target), false);

  const faultDirectory = a1of1TestRoot("pkc-a1of1-remote-test-fault-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(faultDirectory, name), { mode: 0o700 });
  chmodSync(faultDirectory, 0o700);
  const faultNonce = "7".repeat(32);
  const faultStage = stage(faultDirectory, faultNonce);
  const fault = spawnSync("python3", [helper, "finalize", faultDirectory, owner, artifactName, artifactSha, faultNonce, ...faultStage.tokens, checksumSha, receiptSha, sourceReceiptSha], { encoding: "utf8", env: { ...env, PKC_A1OF1_REMOTE_TEST_FAIL_BEFORE_COMMIT: "1" } });
  assert.notEqual(fault.status, 0);
  assert.equal(existsSync(path.join(faultDirectory, "receipts", `${artifactSha}.custody-receipt.json`)), false);

  const abaDirectory = a1of1TestRoot("pkc-a1of1-remote-test-aba-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(abaDirectory, name), { mode: 0o700 });
  chmodSync(abaDirectory, 0o700);
  const abaNonce = "6".repeat(32);
  const abaStage = stage(abaDirectory, abaNonce);
  const abaAway = `${abaDirectory}-away`;
  renameSync(abaDirectory, abaAway);
  renameSync(abaAway, abaDirectory);
  const abaFinalize = finalize(abaDirectory, abaNonce, abaStage.tokens);
  assert.notEqual(abaFinalize.status, 0);
  assert.equal(existsSync(path.join(abaDirectory, "receipts", `${artifactSha}.custody-receipt.json`)), false);

  const collisionDirectory = a1of1TestRoot("pkc-a1of1-remote-test-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(collisionDirectory, name), { mode: 0o700 });
  chmodSync(collisionDirectory, 0o700);
  const collisionNonce = "5".repeat(32);
  const collisionStage = stage(collisionDirectory, collisionNonce);
  const tokenMismatch = finalize(collisionDirectory, collisionNonce, ["0".repeat(64), collisionStage.tokens[1]]);
  assert.notEqual(tokenMismatch.status, 0);
  assert.equal(existsSync(path.join(collisionDirectory, "receipts", `${artifactSha}.custody-receipt.json`)), false);
  const collisionBundle = path.join(collisionDirectory, "bundles", artifactSha);
  mkdirSync(collisionBundle, { mode: 0o700 });
  writeFileSync(path.join(collisionBundle, "unexpected"), "collision", { mode: 0o600 });
  const collision = finalize(collisionDirectory, collisionNonce, collisionStage.tokens);
  assert.notEqual(collision.status, 0);
  assert.equal(existsSync(path.join(collisionDirectory, "receipts", `${artifactSha}.custody-receipt.json`)), false);
  const collisionCleanup = cleanup(collisionDirectory, collisionNonce, collisionStage.tokens);
  assert.equal(collisionCleanup.status, 0, collisionCleanup.stderr);

  const unsafeDirectory = a1of1TestRoot("pkc-a1of1-remote-test-");
  for (const name of ["staging", "bundles", "receipts"]) mkdirSync(path.join(unsafeDirectory, name), { mode: 0o700 });
  chmodSync(unsafeDirectory, 0o700);
  const unsafeNonce = "4".repeat(32);
  writeFileSync(path.join(unsafeDirectory, "staging", unsafeNonce), "unsafe-path", { mode: 0o600 });
  const unsafeCleanup = invoke(unsafeDirectory, unsafeNonce, "cleanup", ["0".repeat(64), "1".repeat(64)]);
  assert.notEqual(unsafeCleanup.status, 0);
  assert.equal(existsSync(path.join(unsafeDirectory, "staging", unsafeNonce)), true);
});

test("cleanup manifest validator requires the exact closed 215-volume schema and never deletes", () => {
  const source = read("scripts/validate-cleanup-manifest.mjs");
  assert.doesNotMatch(source, /docker\s+volume\s+(?:rm|prune)|rmSync|unlinkSync/);
  const dir = temporaryRoot("pkc-cleanup-");
  const volumes = Array.from({ length: 215 }, (_, index) => ({
    ordinal: index + 1,
    name: `legacy_volume_${String(index + 1).padStart(3, "0")}`,
    labels: { "com.docker.compose.project": "legacy", "com.docker.compose.volume": `volume_${String(index + 1).padStart(3, "0")}` },
    expected_mounted: false,
    action: "review_only"
  }));
  const manifest = { schema_version: 1, expected_volume_count: 215, deletion_enabled: false, volumes };
  const valid = jsonFile(dir, "valid.json", manifest);
  assert.equal(run("node", "scripts/validate-cleanup-manifest.mjs", [valid]).status, 0);
  manifest.volumes[214].action = "delete";
  const bad = jsonFile(dir, "bad.json", manifest);
  assert.notEqual(run("node", "scripts/validate-cleanup-manifest.mjs", [bad]).status, 0);
});

test("runbook defines provisioning gates, isolated recovery, rollback, and prohibited live actions", () => {
  const runbook = read("RUNBOOK.md");
  for (const marker of [
    "capacity below 80%", "rendered Compose", "cluster identity receipt", "encrypted backup",
    "isolated restore drill", "volume preservation", "SQLite remains authoritative", "no host port",
    "Rollback", "Do not edit /root/docker-compose.yml", "Do not delete volumes", "A1of1",
    "/Users/aiel/Desktop/PROJECTKIDCREATIONS/recovery/exports/vps-onboarding-postgres", "No recurring schedule is authorized"
  ]) assert.match(runbook, new RegExp(marker, "i"));
  const ordered = ["000_roles.sql", "004_onboarding_roles.sql", "006_backup_reader.sql", "migrations `001`, `002`, `003`, and `004`", "010_seal_migrator.sql", "020_seal_bootstrap.sql"];
  let cursor = -1;
  for (const marker of ordered) {
    const next = runbook.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `runbook sequence missing or out of order: ${marker}`);
    cursor = next;
  }
});
