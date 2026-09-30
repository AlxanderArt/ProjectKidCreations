import { createNodeRouter } from "./node-router.mjs";

export function createVercelNodeHandler(options = {}) {
  return createNodeRouter(options);
}
