import { createNodeHandler } from "../../server/proxy/node.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };
export default createNodeHandler("accountLogin");
