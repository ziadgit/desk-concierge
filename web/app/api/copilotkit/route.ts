import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicAdapter,
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import type { NextRequest } from "next/server";

const runtime = new CopilotRuntime();
let adapter: AnthropicAdapter | null = null;

export const POST = async (req: NextRequest) => {
  // Built on first request rather than at import, so `next build` doesn't
  // need ANTHROPIC_API_KEY.
  adapter ??= new AnthropicAdapter({ anthropic: new Anthropic(), model: "claude-opus-5-5" });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: adapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
