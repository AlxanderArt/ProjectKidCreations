import crypto from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
const admin = (value) => value === true || String(value || "").toUpperCase() === "TRUE";
function snapshotPlain(value) { const seen=new Set(); const visit=(item)=>{if(!item||typeof item!=="object")return;if(seen.has(item))throw new Error("cyclic input");seen.add(item);const proto=Object.getPrototypeOf(item);if(proto!==Object.prototype&&proto!==Array.prototype)throw new Error("non-plain input");for(const key of Reflect.ownKeys(item)){if(typeof key!=="string")throw new Error("symbol input");const d=Object.getOwnPropertyDescriptor(item,key);if(!d||d.get||d.set)throw new Error("accessor input");visit(d.value);}};try{visit(value);return JSON.parse(canonical(value));}catch(error){throw new Error(`unsafe backfill input: ${error instanceof Error?error.message:"error"}`);} }
const exactKeys=(value,keys)=>value&&typeof value==="object"&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());

export function approvalReceiptForPlan(plan) {
  if (!plan || plan.schema !== "pkc-founder-account-id-backfill-plan-v2" || !/^[a-f0-9]{64}$/.test(plan.planDigest || "")) throw new Error("invalid backfill plan");
  return `APPLY FOUNDER ACCOUNT_ID BACKFILL ${plan.planDigest}`;
}

export function planFounderAccountIdBackfill(inventory, { proposedAccountId = crypto.randomUUID() } = {}) {
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error("exactly one founder target required");
  if (!UUID_RE.test(String(proposedAccountId || ""))) throw new Error("invalid proposed founder account_id");
  const normalized = inventory.map((row) => ({ row_ref: row?.row_ref, username: row?.username, is_admin: admin(row?.is_admin), account_id: row?.account_id == null || row?.account_id === "" ? null : String(row.account_id) }));
  for (const row of normalized) {
    if (row.account_id !== null && !UUID_RE.test(row.account_id)) throw new Error("malformed existing account_id");
    const signals = [row.username === "PK Blick", row.is_admin === true];
    if (signals.some(Boolean) && !signals.every(Boolean)) throw new Error("partial founder signal refused");
  }
  const founders = normalized.filter((row) => row.username === "PK Blick" && row.is_admin === true);
  if (founders.length !== 1) throw new Error("exactly one founder target required");
  const target = founders[0];
  if (typeof target.row_ref !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(target.row_ref)) throw new Error("founder row_ref required");
  if (target.account_id !== null) throw new Error("founder account_id already assigned");
  if (normalized.some((row) => row.account_id === proposedAccountId)) throw new Error("proposed founder account_id already exists");
  const candidateAuthority = Object.freeze({ row_ref: target.row_ref, username: "PK Blick", is_admin: true, expected_account_id: null });
  const mutationPayload = Object.freeze({ operation: "set_account_id_once", ...candidateAuthority, account_id: proposedAccountId });
  const inventoryDigest = digest(normalized);
  const planCore = { schema: "pkc-founder-account-id-backfill-plan-v2", candidateAuthority, proposedAccountId, inventoryDigest, mutationPayload };
  const planDigest = digest(planCore);
  return Object.freeze({ ...planCore, planDigest, mode: "dry-run", authority: Object.freeze({ username: "PK Blick", is_admin: true, email_authority: false, match_count: 1 }), receipt: Object.freeze({ planned: true, executed: false, planDigest }) });
}

export async function applyBackfillPlan(plan, { approvalReceipt, adapter } = {}) {
  ({plan,approvalReceipt}=snapshotPlain({plan,approvalReceipt}));
  if (!plan || plan.schema !== "pkc-founder-account-id-backfill-plan-v2") throw new Error("invalid backfill plan");
  const planCore = { schema: plan.schema, candidateAuthority: plan.candidateAuthority, proposedAccountId: plan.proposedAccountId, inventoryDigest: plan.inventoryDigest, mutationPayload: plan.mutationPayload };
  if (digest(planCore) !== plan.planDigest) throw new Error("backfill plan drift");
  if (approvalReceipt !== approvalReceiptForPlan(plan)) throw new Error("typed approval receipt mismatch");
  if (typeof adapter !== "function") throw new Error("injected backfill adapter required");
  const raw = await adapter(structuredClone(plan.mutationPayload));
  if (!raw || !exactKeys(raw,["mutationRows","readbackRows","cardinalityRows","immutabilityRows"]) || ["verified", "immutable", "unique"].some((key) => typeof raw[key] === "boolean")) throw new Error("raw mutation/readback rows required; booleans are not authority");
  const { mutationRows, readbackRows, cardinalityRows, immutabilityRows } = raw;
  if (![mutationRows, readbackRows, cardinalityRows, immutabilityRows].every(Array.isArray)) throw new Error("raw mutation and separate readback/cardinality/immutability rows required");
  if (mutationRows.length !== 1 || readbackRows.length !== 1 || cardinalityRows.length !== 1 || immutabilityRows.length !== 1) throw new Error("backfill exact-one row authority failed");
  const mutation = mutationRows[0]; const readback = readbackRows[0]; const cardinality = cardinalityRows[0]; const immutable = immutabilityRows[0];
  if(!exactKeys(mutation,["row_ref","before_account_id","after_account_id"])||!exactKeys(readback,["row_ref","account_id","username","is_admin"])||!exactKeys(cardinality,["account_id","row_count"])||!exactKeys(immutable,["row_ref","attempted_account_id","affected_rows","current_account_id"]))throw new Error("backfill evidence shape is not closed");
  const exact = readback.row_ref === plan.candidateAuthority.row_ref && readback.account_id === plan.proposedAccountId && readback.username === "PK Blick" && admin(readback.is_admin)
    && mutation.row_ref === readback.row_ref && (mutation.before_account_id == null || mutation.before_account_id === "") && mutation.after_account_id === plan.proposedAccountId
    && cardinality.account_id === plan.proposedAccountId && Number(cardinality.row_count) === 1
    && immutable.row_ref === readback.row_ref && immutable.current_account_id === plan.proposedAccountId && Number(immutable.affected_rows) === 0 && UUID_RE.test(String(immutable.attempted_account_id || "")) && immutable.attempted_account_id !== plan.proposedAccountId;
  if (!exact) throw new Error("backfill immutability/readback verification failed");
  return Object.freeze({ schema: "pkc-founder-account-id-backfill-receipt-v2", planDigest: plan.planDigest, accountId: plan.proposedAccountId, verified: true });
}
