/**
 * Rajasthan RERA portal client.
 *
 * Reproduces the website flow:
 *   1. POST GetProjects (search by project name) on reraapi.rajasthan.gov.in
 *   2. GET  ProjectDtlsWebsite/{EncryptedProjectId} on reraapp.rajasthan.gov.in
 *      -> yields data.ProjectId (a second, differently-encrypted token)
 *   3. GET  ViewProjectWebsite?id={ProjectId}&type=U on reraapp.rajasthan.gov.in
 *      -> the full "updated" project record
 */

const SEARCH_HOST = "https://reraapi.rajasthan.gov.in";
const APP_HOST = "https://reraapp.rajasthan.gov.in";

const SEARCH_URL = `${SEARCH_HOST}/api/web/Home/GetProjects`;
const DTLS_URL = `${APP_HOST}/HomeWebsite/ProjectDtlsWebsite`;
const VIEW_URL = `${APP_HOST}/HomeWebsite/ViewProjectWebsite`;

// Browser-like headers. The portal can be picky about a missing UA / Referer.
const COMMON_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: SEARCH_HOST,
  Referer: `${SEARCH_HOST}/`,
  "X-Api-Key": "MySuperSecretApiKey_123",
};

const DEFAULT_TIMEOUT_MS = 30_000;

export interface SearchResultItem {
  id: number;
  projectName: string;
  promoterName: string;
  district: string;
  projectType: string;
  registrationNo: string;
  approvedOn: string | null;
  projectStatus: string;
  revisedCompletionDate: string | null;
  encryptedProjectId: string;
}

export class RajReraError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RajReraError";
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new RajReraError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new RajReraError(`Network error contacting ${url}`, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1: search projects by name. */
export async function searchProjects(
  projectName: string
): Promise<SearchResultItem[]> {
  const body = {
    DistrictId: "0",
    TeshilId: "0",
    ProjectName: projectName,
    PromoterName: null,
    RegistrationNo: null,
    ProjectType: 0,
    ApplicationStatus: "0",
    Year: 0,
  };

  const res = await fetchWithTimeout(SEARCH_URL, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new RajReraError(
      `Search failed: ${res.status} ${res.statusText}`
    );
  }

  let json: any;
  try {
    json = await res.json();
  } catch (err) {
    throw new RajReraError("Search returned a non-JSON response", err);
  }

  const data: any[] = Array.isArray(json?.Data) ? json.Data : [];
  return data.map(normalizeSearchItem);
}

function normalizeSearchItem(d: any): SearchResultItem {
  return {
    id: d.Id,
    projectName: (d.ProjectName ?? "").trim(),
    promoterName: (d.PromoterName ?? "").trim(),
    district: d.DistrictName ?? "",
    projectType: d.ProjectTypeName ?? "",
    registrationNo: d.REGISTRATIONNO ?? "",
    approvedOn: cleanDate(d.APPROVEDON),
    projectStatus: mapProjectStatus(d.ProjectStatus),
    revisedCompletionDate: d.RevisedDateOfComplation ?? null,
    encryptedProjectId: d.EncryptedProjectId,
  };
}

/** Step 2: exchange EncryptedProjectId for the inner ProjectId token. */
export async function resolveProjectIdToken(
  encryptedProjectId: string
): Promise<string> {
  const url = `${DTLS_URL}/${encodeURIComponent(encryptedProjectId)}`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { ...COMMON_HEADERS, Referer: `${APP_HOST}/` },
  });

  if (!res.ok) {
    throw new RajReraError(
      `ProjectDtls lookup failed: ${res.status} ${res.statusText}`
    );
  }

  let json: any;
  try {
    json = await res.json();
  } catch (err) {
    throw new RajReraError("ProjectDtls returned a non-JSON response", err);
  }

  const token: string | undefined = json?.data?.ProjectId;
  if (!token) {
    throw new RajReraError(
      "ProjectDtls response did not contain data.ProjectId"
    );
  }
  return token;
}

/** Step 3: fetch the full "updated" project record. */
export async function fetchProjectDetail(projectIdToken: string): Promise<any> {
  // The token already carries its own base64 padding (e.g. "Mbg2IcH8uis=").
  // encodeURIComponent turns "=" into "%3D" so it survives as a query value.
  const url = `${VIEW_URL}?id=${encodeURIComponent(projectIdToken)}&type=U`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { ...COMMON_HEADERS, Referer: `${APP_HOST}/` },
  });

  if (!res.ok) {
    throw new RajReraError(
      `ViewProject failed: ${res.status} ${res.statusText}`
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new RajReraError("ViewProject returned a non-JSON response", err);
  }
}

/* ----------------------------- helpers ----------------------------- */

/** Parse Microsoft JSON date: "/Date(1710613800000)/" -> ISO date string. */
export function parseDotNetDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/\/Date\((-?\d+)\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  // The portal uses a sentinel "min date" (~year 1) for unset values.
  if (ms < 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Trim and null-out empty/whitespace date strings like "2026-01-20T..." */
function cleanDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value.trim() : d.toISOString().slice(0, 10);
}

function mapProjectStatus(code: unknown): string {
  switch (code) {
    case 3:
      return "Registered";
    case 2:
      return "Approved";
    case 1:
      return "Submitted";
    default:
      return code == null ? "Unknown" : `Status ${code}`;
  }
}
