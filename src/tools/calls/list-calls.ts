import { z } from "zod";
import { CALL_STATUSES, listCalls } from "../../ringg/calls.js";
import { defineTool } from "../types.js";

export const listCallsTool = defineTool({
  name: "list_calls",
  title: "List call history",
  description:
    "List calls from the Ringg workspace with optional filters. Returns SUMMARIES ONLY - status, " +
    "duration, cost, agent and timestamps. Transcripts and recording URLs are deliberately " +
    "omitted here; use get_call for a specific call's transcript or analysis. Dates must be " +
    "ISO 8601 with a timezone offset, e.g. 2026-08-01T00:00:00+05:30.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(20).describe("Number of calls to return (1-100)."),
    offset: z.number().int().min(0).default(0).describe("Number of calls to skip, for paging."),
    agent_id: z.string().min(1).optional().describe("Only return calls handled by this agent."),
    status: z.enum(CALL_STATUSES).optional().describe("Only return calls with this status."),
    bulk_list_id: z.string().min(1).optional().describe("Only return calls from this campaign / bulk list."),
    start_date: z
      .string()
      .min(1)
      .optional()
      .describe("Earliest call date, ISO 8601 with offset. Omitted entirely if not supplied."),
    end_date: z
      .string()
      .min(1)
      .optional()
      .describe("Latest call date, ISO 8601 with offset. Omitted entirely if not supplied."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    return listCalls(client, {
      limit: args.limit,
      offset: args.offset,
      agent_id: args.agent_id,
      status: args.status,
      bulk_list_id: args.bulk_list_id,
      start_date: args.start_date,
      end_date: args.end_date,
    });
  },
});
