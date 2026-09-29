import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationPath = new URL("../../db/migrations/001_founder_mfa.sql", import.meta.url);
const sql = readFileSync(migrationPath, "utf8");

const table = (name) => new RegExp(`CREATE TABLE pkc_auth\\.${name}\\b`, "i");

test("founder MFA migration creates the complete transactional authority", () => {
  for (const name of [
    "founder_mfa_factors",
    "founder_mfa_challenges",
    "founder_mfa_recovery_codes",
    "founder_mfa_finalizations",
    "founder_mfa_outbox",
    "founder_mfa_audit_events",
  ]) assert.match(sql, table(name), name);

  assert.match(sql, /REVOKE ALL ON SCHEMA pkc_auth FROM PUBLIC/i);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA pkc_auth FROM PUBLIC/i);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE pkc_mfa_owner IN SCHEMA pkc_auth REVOKE ALL ON TABLES FROM PUBLIC/i);
});

test("factor and challenge constraints fail closed on envelope, replay, state, and attempt drift", () => {
  assert.match(sql, /founder_subject uuid NOT NULL UNIQUE/i);
  assert.match(sql, /octet_length\(secret_nonce\)\s*=\s*12/i);
  assert.match(sql, /octet_length\(secret_tag\)\s*=\s*16/i);
  assert.match(sql, /octet_length\(token_hash\)\s*=\s*32/i);
  assert.match(sql, /octet_length\(anti_csrf_hash\)\s*=\s*32/i);
  assert.match(sql, /last_accepted_counter/i);
  assert.match(sql, /auth_epoch[^,]*CHECK \(auth_epoch\s*>=\s*0\)/i);
  assert.match(sql, /attempts_used[^,]*CHECK \(attempts_used\s*>=\s*0\)/i);
  assert.match(sql, /max_attempts[^,]*CHECK \(max_attempts BETWEEN 1 AND 10\)/i);
  assert.match(sql, /CHECK \(attempts_used\s*<=\s*max_attempts\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX[^;]+founder_mfa_challenges[^;]+WHERE state\s*=\s*'pending'/is);
});

test("finalization schema binds one challenge to one stable retry identity and fenced outcome", () => {
  assert.match(sql, /challenge_id uuid NOT NULL UNIQUE/i);
  assert.match(sql, /grant_jti uuid NOT NULL UNIQUE/i);
  assert.match(sql, /session_id uuid NOT NULL UNIQUE/i);
  assert.match(sql, /request_digest bytea NOT NULL CHECK \((?:pg_catalog\.)?octet_length\(request_digest\)\s*=\s*32\)/i);
  assert.match(sql, /state text NOT NULL(?: DEFAULT 'pending')? CHECK \(state IN \('pending','dispatching','unknown','succeeded','terminal_rejected'\)\)/i);
  assert.match(sql, /lease_fence bigint NOT NULL DEFAULT 0 CHECK \(lease_fence\s*>=\s*0\)/i);
  assert.match(sql, /receipt_digest bytea CHECK \(receipt_digest IS NULL OR (?:pg_catalog\.)?octet_length\(receipt_digest\)\s*=\s*32\)/i);
});

test("migration never stores plaintext proof material", () => {
  for (const forbidden of ["plaintext_secret", "otpauth_uri", "submitted_otp", "recovery_code_plaintext", "password_value", "grant_value"]) {
    assert.equal(sql.includes(forbidden), false, forbidden);
  }
});
