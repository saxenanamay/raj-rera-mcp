# raj-rera-mcp

An MCP server that fetches the latest registered details for a **Rajasthan RERA**
project, given just a project name. It reproduces the public portal flow end to
end so you don't have to click through it.

## What it does

One tool: **`get_project_details`**

Input:
- `projectName` (required) — full or partial name, e.g. `PARK AVENUE`
- `registrationNo` (optional) — e.g. `RAJ/P/2024/3092`, to disambiguate

Behavior:
- **One match** → returns the full normalized project record.
- **Multiple matches** → returns a numbered candidate list (name, registration
  no, promoter, district, type, status). Call again with the exact name or a
  `registrationNo`.
- **No match** → says so.

Under the hood it runs the same three calls the website makes:

1. `POST reraapi.rajasthan.gov.in/api/web/Home/GetProjects` — search by name.
2. `GET  reraapp.rajasthan.gov.in/HomeWebsite/ProjectDtlsWebsite/{EncryptedProjectId}`
   — exchange the list token for the inner `ProjectId`.
3. `GET  reraapp.rajasthan.gov.in/HomeWebsite/ViewProjectWebsite?id={ProjectId}&type=U`
   — the full "updated" record.

The raw step-3 payload is ~8k lines; the server normalizes it down to a compact
object: project basics, promoter + partners, location, key dates (parsed from
.NET `/Date(...)/` epoch format), area/building counts, an aggregated unit
summary (collapsed by type, with booked counts), professionals, financials, and
absolute URLs for every uploaded document.

## Setup

```bash
npm install
npm run build
```

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "raj-rera": {
      "command": "node",
      "args": ["/absolute/path/to/raj-rera-mcp/dist/index.js"]
    }
  }
}
```

Then ask: *"Get the RAJ RERA details for Park Avenue in Kota."*

## Notes / caveats

- This hits a live government portal. It can be slow, rate-limit, or change its
  response shape without notice. The client sends browser-like headers and a
  30s timeout; if the portal starts requiring a session cookie or CAPTCHA, the
  unauthenticated calls here will need revisiting.
- The normalizer is defensive (missing fields become `null`/empty arrays), so a
  partially-populated project still returns cleanly.
- Quarterly/Annual report period lists appear on the search-stage payload rather
  than the detail payload, so they're stubbed as empty here; wire them in from
  step 1 if you need them.
- Respect the portal's terms of use and don't hammer it.
