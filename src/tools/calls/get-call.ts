import { z } from "zod";
import { CALL_VIEWS, getCall } from "../../ringg/calls.js";
import { defineTool } from "../types.js";

export const getCallTool = defineTool({
  name: "get_call",
  title: "Get call details",
  description:
    "Get one call by id. The 'view' parameter controls how much is returned: " +
    "'summary' (default) is metadata only; 'transcript' adds the conversation turns; " +
    "'analysis' adds Ringg's platform analysis and any custom client analysis; " +
    "'full' returns everything. Prefer the narrowest view that answers the question - " +
    "transcripts and analysis payloads can be large. Recording URLs expire 24 hours after the call.",
  inputSchema: {
    call_id: z.string().min(1).describe("The call UUID, as returned by list_calls."),
    view: z
      .enum(CALL_VIEWS)
      .default("summary")
      .describe("summary | transcript | analysis | full. Defaults to summary."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    return getCall(client, args.call_id, args.view);
  },
});
