import { pgBigint } from "./pg-bigint.mjs";

function exact(value, expected) { return typeof value === "string" && value === expected; }

export function enrollmentAuthorizationMatches(row, expected, now = new Date()) {
  if (!row || !expected || !(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const expiry = new Date(row.expires_at);
  const issued = new Date(row.issued_at);
  return exact(row.founder_subject, expected.founderSubject)
    && exact(row.source_commit, expected.sourceCommit)
    && exact(row.deployment_id, expected.deploymentId)
    && exact(row.workflow_digest, expected.workflowDigest)
    && exact(row.approval_id, expected.approvalId)
    && exact(row.expected_factor_state, expected.factorState)
    && pgBigint(row.expected_auth_epoch, "expected_auth_epoch") === pgBigint(expected.authEpoch, "expected_auth_epoch")
    && row.consumed_at === null
    && !Number.isNaN(issued.getTime()) && issued.getTime() <= now.getTime()
    && !Number.isNaN(expiry.getTime()) && expiry.getTime() >= now.getTime();
}

export function enrollmentAuthorityFromConfig(config, factor, authorization) {
  if (!authorization || typeof authorization.approval_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(authorization.approval_id)) {
    throw new TypeError("invalid_enrollment_approval_authority");
  }
  return Object.freeze({
    founderSubject: config.founderSubject,
    sourceCommit: config.deployment.sourceCommit,
    deploymentId: config.deployment.deploymentId,
    workflowDigest: config.deployment.workflowDigest,
    approvalId: authorization.approval_id,
    factorState: factor.state,
    authEpoch: pgBigint(factor.auth_epoch, "auth_epoch"),
  });
}
