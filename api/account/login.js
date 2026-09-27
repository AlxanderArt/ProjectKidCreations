import { createFounderLoginUpstreamTransform } from "../../server/mfa/login-integration.mjs";
import { beginTrustedFounderMfa } from "../../server/mfa/routes.mjs";
import { createNodeHandler } from "../../server/proxy/node.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

const transformUpstream = createFounderLoginUpstreamTransform({
  beginFounderMfa: (handoff) => beginTrustedFounderMfa(handoff),
});

export default createNodeHandler("accountLogin", { transformUpstream });
