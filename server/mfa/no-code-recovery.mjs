const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_RE = /^[a-z][a-z0-9_-]{7,127}$/;
const FIELDS = ["operationId", "founderSubject", "reasonCode"];

function closed(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError(code);
}

export function validateNoCodeRecoveryRequest(value) {
  closed(value, FIELDS, "unknown_recovery_field");
  if (!ID_RE.test(value.operationId || "")) throw new TypeError("invalid_operation_id");
  if (!UUID_RE.test(value.founderSubject || "")) throw new TypeError("invalid_founder_subject");

  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value.reasonCode || "")) throw new TypeError("invalid_reason_code");
  return Object.freeze({ ...value });
}
