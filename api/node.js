import { createVercelNodeHandler } from "../server/api/vercel-node-router.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };
export default createVercelNodeHandler();
