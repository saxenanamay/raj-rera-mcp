#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchProjects,
  resolveProjectIdToken,
  fetchProjectDetail,
  RajReraError,
  type SearchResultItem,
} from "./client.js";
import { normalizeProjectDetail } from "./normalize.js";

const server = new McpServer({
  name: "raj-rera",
  version: "1.0.0",
});

/**
 * Single tool: given a project name, run the full portal chain and return
 * the updated project details. If the search is ambiguous, return the list
 * of candidates so the caller can disambiguate (by name+registration no).
 */
server.registerTool(
  "get_project_details",
  {
    title: "Get RAJ-RERA project details",
    description:
      "Fetch the latest registered details for a Rajasthan RERA project by name. " +
      "If exactly one project matches, returns its full updated details. " +
      "If multiple match, returns a list of candidates to choose from — call again " +
      "with the exact project name or the registrationNo to disambiguate. " +
      "If none match, says so.",
    inputSchema: {
      projectName: z
        .string()
        .min(2)
        .describe("Full or partial project name, e.g. 'PARK AVENUE'."),
      registrationNo: z
        .string()
        .optional()
        .describe(
          "Optional RERA registration number (e.g. 'RAJ/P/2024/3092') to pick " +
            "one project when the name alone is ambiguous."
        ),
    },
  },
  async ({ projectName, registrationNo }) => {
    try {
      const results = await searchProjects(projectName);

      if (results.length === 0) {
        return text(
          `No projects found on the Rajasthan RERA portal matching "${projectName}".`
        );
      }

      // Narrow by registration number if provided.
      let candidates = results;
      if (registrationNo) {
        const wanted = registrationNo.trim().toLowerCase();
        candidates = results.filter(
          (r) => r.registrationNo.toLowerCase() === wanted
        );
        if (candidates.length === 0) {
          return text(
            `No project named like "${projectName}" has registration number ` +
              `"${registrationNo}". Candidates found:\n\n${formatCandidates(results)}`
          );
        }
      }

      if (candidates.length > 1) {
        return text(
          `Multiple projects match "${projectName}". Re-run get_project_details ` +
            `with the exact project name or pass registrationNo to pick one:\n\n` +
            formatCandidates(candidates)
        );
      }

      // Exactly one: resolve and fetch.
      const chosen = candidates[0];
      const token = await resolveProjectIdToken(chosen.encryptedProjectId);
      const raw = await fetchProjectDetail(token);
      const normalized = normalizeProjectDetail(raw);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                source: "Rajasthan RERA portal",
                fetchedAt: new Date().toISOString(),
                registrationNo: chosen.registrationNo,
                project: normalized,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const msg =
        err instanceof RajReraError
          ? err.message
          : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  }
);

function formatCandidates(items: SearchResultItem[]): string {
  return items
    .map(
      (r, i) =>
        `${i + 1}. ${r.projectName} — ${r.registrationNo}\n` +
        `   Promoter: ${r.promoterName || "—"}\n` +
        `   District: ${r.district || "—"} | Type: ${r.projectType || "—"} | ` +
        `Status: ${r.projectStatus}`
    )
    .join("\n\n");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  process.stderr.write("raj-rera MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
