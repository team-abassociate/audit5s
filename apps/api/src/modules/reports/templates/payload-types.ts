/**
 * Re-exported payload types, so a template imports one local module rather than reaching
 * into `@audit5s/contracts` for a dozen names. There is no second definition here — every
 * type below is the contracts one (STACK.md §3's "never define a shared type twice").
 */
export type {
  ReportClosure,
  ReportNonconformity,
  ReportOutcome,
  ReportPayload,
  ReportPhoto,
  ReportQuestion,
  ReportSummaryExtras,
  ReportZone,
  SectionScorePayload,
} from '@audit5s/contracts';

/** The band shape as frozen on a payload — structurally the domain's `RatingBand`. */
export interface ReportBand {
  token: string;
  minPercentage: number;
  label: string;
  color: string;
  tint: string;
}
