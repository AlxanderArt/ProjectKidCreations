import { createNodeRouter } from "../server/api/node-router.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };
export default createNodeRouter();
