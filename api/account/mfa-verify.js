import { createNodeMfaHandler } from "../../server/mfa/routes.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };
export default createNodeMfaHandler("verify");
