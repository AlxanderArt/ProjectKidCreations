import { createEdgeHandler } from "../../server/proxy/edge.mjs";

export const config = { runtime: "edge" };
export default createEdgeHandler("accountSessions");
