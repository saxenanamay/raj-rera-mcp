import { parseDotNetDate } from "./client.js";

const APP_HOST = "https://reraapp.rajasthan.gov.in";

/** Turn portal-relative paths like "../Content/uploads/x.pdf" into absolute URLs. */
function absoluteUrl(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  let p = path.trim();
  p = p.replace(/^~\//, "/").replace(/^\.\.\//, "/").replace(/^\.\//, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  return `${APP_HOST}${p}`;
}

export interface NormalizedDocument {
  category: string;
  name: string;
  uploadedFileName: string | null;
  url: string | null;
}

export interface UnitSummaryRow {
  type: string;
  count: number;
  booked: number;
  carpetAreaSqm: number | null;
}

export interface NormalizedProject {
  projectName: string;
  registrationNo: string;
  applicationNo: string | null;
  projectType: string;
  status: string;
  promoter: {
    name: string;
    type: string | null;
    officePhone: string | null;
    address: string | null;
    partners: { name: string; designation: string }[];
  };
  location: {
    plotNo: string | null;
    village: string | null;
    tehsil: string | null;
    district: string | null;
    pincode: string | null;
  };
  dates: {
    registeredOn: string | null;
    originalCompletion: string | null;
    revisedCompletion: string | null;
    actualCommencement: string | null;
    actualFinish: string | null;
  };
  area: {
    projectAreaSqm: number | null;
    openSpaceSqm: number | null;
    builtUpAreaFsiSqm: number | null;
    totalBuildings: number | null;
    sanctionedBuildings: number | null;
  };
  units: {
    totalUnits: number;
    bookedUnits: number;
    byType: UnitSummaryRow[];
  };
  professionals: {
    architects: ProfessionalRow[];
    engineers: ProfessionalRow[];
    cas: ProfessionalRow[];
  };
  financials: {
    estimatedLandCost: number | null;
    estimatedDevelopmentCost: number | null;
    registrationFeePaid: number | null;
  };
  documents: NormalizedDocument[];
  reportingPeriods: {
    quarterlyReports: string[];
    annualReports: string[];
  };
  certificateUrl: string | null;
}

interface ProfessionalRow {
  name: string;
  contact: string | null;
  email: string | null;
}

export function normalizeProjectDetail(raw: any): NormalizedProject {
  const basic = raw?.GetProjectBasic ?? {};
  const promoterDetails = raw?.PromoterDetails ?? {};
  const prof = raw?.ProjectProFessionAlDetail ?? {};
  const costs: any[] = Array.isArray(raw?.GetProjectCostDetail)
    ? raw.GetProjectCostDetail
    : [];

  // ---- units (aggregate from building -> apartment details) ----
  const byType = new Map<string, UnitSummaryRow>();
  let totalUnits = 0;
  let bookedUnits = 0;
  const buildings: any[] = Array.isArray(raw?.GetBuildingDetails)
    ? raw.GetBuildingDetails
    : [];
  for (const b of buildings) {
    const apts: any[] = Array.isArray(b?.GetAppartmentDetails)
      ? b.GetAppartmentDetails
      : [];
    for (const a of apts) {
      const n = Number(a?.NumberOfApartments) || 0;
      const booked = Number(a?.NumberOfApartmentsBooked) || 0;
      totalUnits += n;
      bookedUnits += booked;
      const key = normalizeUnitType(a?.ApartmentType);
      const existing = byType.get(key);
      if (existing) {
        existing.count += n;
        existing.booked += booked;
      } else {
        byType.set(key, {
          type: key,
          count: n,
          booked,
          carpetAreaSqm: numOrNull(a?.CarpetArea),
        });
      }
    }
  }

  // ---- documents (dedupe, keep ones that actually have a file) ----
  const docs: NormalizedDocument[] = [];
  const seen = new Set<string>();
  const docList: any[] = Array.isArray(raw?.GetDocumentsList)
    ? raw.GetDocumentsList
    : [];
  for (const d of docList) {
    const url = absoluteUrl(d?.DocumentUrl);
    if (!url) continue;
    const dedupeKey = url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    docs.push({
      category: d?.MasterType ?? "Other",
      name: (d?.ApplicationDocumentName ?? "").trim(),
      uploadedFileName: d?.DocumentName ?? null,
      url,
    });
  }

  return {
    projectName: (basic?.Name ?? "").trim(),
    registrationNo: basic?.RegistrationNo ?? "",
    applicationNo: basic?.ApplicationNo ?? null,
    projectType: basic?.ProjectTypeName ?? "",
    status: raw?.StatusOfProject ?? "Unknown",
    promoter: {
      name: promoterDetails?.OrgName?.trim() || joinName(promoterDetails),
      type: basic?.PromoterType != null ? null : null, // not reliably present
      officePhone: promoterDetails?.OfficeNo ?? null,
      address: formatAddress(promoterDetails?.Address),
      partners: Array.isArray(promoterDetails?.PartnerModel)
        ? promoterDetails.PartnerModel.map((p: any) => ({
            name: (p?.PartnerName ?? "").trim(),
            designation: (p?.Designation ?? "").trim(),
          }))
        : [],
    },
    location: {
      plotNo: basic?.PlotNo?.trim() ?? null,
      village: basic?.VillageName?.trim() ?? null,
      tehsil: basic?.TahsilName ?? null,
      district: basic?.DistrictName ?? null,
      pincode: basic?.PinCode ?? null,
    },
    dates: {
      registeredOn: parseDotNetDate(basic?.ApprovedOn),
      originalCompletion: parseDotNetDate(basic?.DateOfComplation),
      revisedCompletion: parseDotNetDate(basic?.RevisedDateOfComplation),
      actualCommencement: parseDotNetDate(basic?.ActualCommencementDate),
      actualFinish: parseDotNetDate(basic?.ActualfinishDate),
    },
    area: {
      projectAreaSqm: numOrNull(basic?.PhaseArea ?? basic?.Area),
      openSpaceSqm: numOrNull(basic?.AggregateAreaOpenSpace),
      builtUpAreaFsiSqm: numOrNull(basic?.BuiltUpAreaFSI),
      totalBuildings: numOrNull(basic?.TotalBuildingCount),
      sanctionedBuildings: numOrNull(basic?.SanctionedbuildingCount),
    },
    units: {
      totalUnits,
      bookedUnits,
      byType: [...byType.values()].sort((a, b) => a.type.localeCompare(b.type)),
    },
    professionals: {
      architects: mapProfessionals(prof?.Architect),
      engineers: mapProfessionals([
        ...(prof?.Engineer ?? []),
        ...(prof?.NewEngineer ?? []),
      ]),
      cas: mapProfessionals(prof?.CA),
    },
    financials: {
      estimatedLandCost: findCost(costs, "Estimated Land Cost"),
      estimatedDevelopmentCost: findCost(costs, "Estimated Development Cost"),
      registrationFeePaid: numOrNull(
        raw?.ProjectSummaryPayment?.Amount ?? basic?.Fees
      ),
    },
    documents: docs,
    reportingPeriods: {
      quarterlyReports: [], // QPR list lives on the search-stage payload, not here
      annualReports: [],
    },
    certificateUrl: absoluteUrl(basic?.CertiPath),
  };
}

/* --------------------------- small helpers --------------------------- */

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function joinName(p: any): string {
  return [p?.FirstName, p?.MiddleName, p?.LastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function formatAddress(addr: any): string | null {
  if (!addr) return null;
  const parts = [
    addr.PlotNumber,
    addr.StreetName,
    addr.VillageName,
    addr.Taluka,
    addr.DistrictName,
    addr.StateName,
    addr.ZipCode,
  ]
    .map((s) => (s ?? "").toString().trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function mapProfessionals(list: any): ProfessionalRow[] {
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({
    name: (p?.Name ?? "").trim(),
    contact: p?.ContactNumber ?? null,
    email: p?.Email ?? null,
  }));
}

function findCost(costs: any[], label: string): number | null {
  const row = costs.find((c) => (c?.Name ?? "").trim() === label);
  return row ? numOrNull(row.EstimatedAmount) : null;
}

/** Collapse "3 BHK (TYPE-1) FLAT NO. 301, 401..." down to "3 BHK (TYPE-1)". */
function normalizeUnitType(t: unknown): string {
  const s = (t ?? "").toString().trim();
  const m = s.match(/^(.*?)\s*FLAT NO\./i);
  return (m ? m[1] : s).trim() || "Unspecified";
}
