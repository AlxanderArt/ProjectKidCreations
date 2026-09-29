export const PG_BIGINT_MAX = "9223372036854775807";

export function pgBigint(value, label = "pg_bigint") {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)
      || value.length > PG_BIGINT_MAX.length
      || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

export function incrementPgBigint(value, label = "pg_bigint") {
  const canonical = pgBigint(value, label);
  if (canonical === PG_BIGINT_MAX) throw new RangeError(`invalid_${label}`);
  return (BigInt(canonical) + 1n).toString(10);
}
