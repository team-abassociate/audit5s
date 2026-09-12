import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common';
import { sSectionSchema } from './enums';

export const analyticsRangeQuerySchema = z.object({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  minSamples: z.coerce.number().int().min(1).max(100).default(3),
});
export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;

export const analyticsTrendQuerySchema = analyticsRangeQuerySchema.extend({
  metric: z.literal('score').default('score'),
  granularity: z.enum(['day', 'month']).default('month'),
});
export type AnalyticsTrendQuery = z.infer<typeof analyticsTrendQuerySchema>;

export const analyticsRankingQuerySchema = analyticsRangeQuerySchema.extend({
  order: z.enum(['best', 'worst']).default('best'),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type AnalyticsRankingQuery = z.infer<typeof analyticsRankingQuerySchema>;

export const analyticsActivityQuerySchema = analyticsRangeQuerySchema.extend({
  unitId: uuidSchema.optional(),
});
export type AnalyticsActivityQuery = z.infer<typeof analyticsActivityQuerySchema>;

export const scoreMetricSchema = z.object({
  rawScore: z.number().nonnegative(),
  maxScore: z.number().nonnegative(),
  scorePercentage: z.number().min(0).max(100).nullable(),
  sampleCount: z.number().int().nonnegative(),
});
export type ScoreMetric = z.infer<typeof scoreMetricSchema>;

export const zoneRankingItemSchema = z.object({
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  rank: z.number().int().positive().nullable(),
  score: scoreMetricSchema,
  lastScore: z.number().min(0).max(100).nullable(),
  previousScore: z.number().min(0).max(100).nullable(),
  improvement: z.number().nullable(),
  auditCount: z.number().int().nonnegative(),
  lastAuditAt: isoDateTimeSchema.nullable(),
  daysSinceLastAudit: z.number().int().nonnegative().nullable(),
  dominantWeakSection: sSectionSchema.nullable(),
  openNonconformities: z.number().int().nonnegative(),
});
export type ZoneRankingItem = z.infer<typeof zoneRankingItemSchema>;

export const unitRankingItemSchema = z.object({
  unitId: uuidSchema,
  unitName: z.string(),
  rank: z.number().int().positive().nullable(),
  score: scoreMetricSchema,
});
export type UnitRankingItem = z.infer<typeof unitRankingItemSchema>;

export const syncHealthSchema = z.object({
  devicesWithUnsyncedData: z.number().int().nonnegative(),
  deadLetterCount: z.number().int().nonnegative(),
  oldestPendingAt: isoDateTimeSchema.nullable(),
});
export type SyncHealth = z.infer<typeof syncHealthSchema>;

export const organizationOverviewSchema = z.object({
  auditCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  score: scoreMetricSchema,
  openNonconformities: z.number().int().nonnegative(),
  closedNonconformities: z.number().int().nonnegative(),
  closureRatePercentage: z.number().min(0).max(100).nullable(),
  averageClosureHours: z.number().nonnegative().nullable(),
  activeAuditors: z.number().int().nonnegative(),
  unitRanking: z.array(unitRankingItemSchema),
  syncHealth: syncHealthSchema,
});
export type OrganizationOverview = z.infer<typeof organizationOverviewSchema>;

export const unitOverviewSchema = z.object({
  unitId: uuidSchema,
  auditCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  zoneCount: z.number().int().nonnegative(),
  score: scoreMetricSchema,
  openNonconformities: z.number().int().nonnegative(),
  closedNonconformities: z.number().int().nonnegative(),
  closureRatePercentage: z.number().min(0).max(100).nullable(),
  averageClosureHours: z.number().nonnegative().nullable(),
  activeAuditors: z.number().int().nonnegative(),
});
export type UnitOverview = z.infer<typeof unitOverviewSchema>;

export const scoreTrendPointSchema = scoreMetricSchema.extend({
  period: z.string(),
  auditCount: z.number().int().nonnegative(),
});
export type ScoreTrendPoint = z.infer<typeof scoreTrendPointSchema>;

export const zoneTrendSeriesSchema = z.object({
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  points: z.array(
    z.object({
      completedAt: isoDateTimeSchema,
      scorePercentage: z.number().min(0).max(100),
      improvement: z.number().nullable(),
    }),
  ),
});
export type ZoneTrendSeries = z.infer<typeof zoneTrendSeriesSchema>;

export const unitTrendSchema = z.object({
  unitId: uuidSchema,
  granularity: z.enum(['day', 'month']),
  points: z.array(scoreTrendPointSchema),
  zones: z.array(zoneTrendSeriesSchema),
});
export type UnitTrend = z.infer<typeof unitTrendSchema>;

export const sectionMetricSchema = z.object({
  section: sSectionSchema,
  currentScorePercentage: z.number().min(0).max(100).nullable(),
  previousScorePercentage: z.number().min(0).max(100).nullable(),
  sampleCount: z.number().int().nonnegative(),
});
export type SectionMetric = z.infer<typeof sectionMetricSchema>;

export const sectionTrendPointSchema = z.object({
  period: z.string(),
  section: sSectionSchema,
  scorePercentage: z.number().min(0).max(100).nullable(),
  sampleCount: z.number().int().nonnegative(),
});
export type SectionTrendPoint = z.infer<typeof sectionTrendPointSchema>;

export const unitSectionsSchema = z.object({
  unitId: uuidSchema,
  radar: z.array(sectionMetricSchema),
  trend: z.array(sectionTrendPointSchema),
});
export type UnitSections = z.infer<typeof unitSectionsSchema>;

export const recurrentNonconformitySchema = z.object({
  checklistQuestionId: uuidSchema,
  questionText: z.string(),
  section: sSectionSchema,
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  failureCount: z.number().int().min(2),
  lastSeenAt: isoDateTimeSchema,
});
export type RecurrentNonconformity = z.infer<typeof recurrentNonconformitySchema>;

export const closureBreakdownSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  opened: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  closureRatePercentage: z.number().min(0).max(100).nullable(),
  averageClosureHours: z.number().nonnegative().nullable(),
});
export type ClosureBreakdown = z.infer<typeof closureBreakdownSchema>;

export const closureAnalyticsSchema = z.object({
  opened: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  closureRatePercentage: z.number().min(0).max(100).nullable(),
  averageClosureHours: z.number().nonnegative().nullable(),
  byUnit: z.array(closureBreakdownSchema),
  byZone: z.array(closureBreakdownSchema),
  byLeader: z.array(closureBreakdownSchema),
});
export type ClosureAnalytics = z.infer<typeof closureAnalyticsSchema>;

export const consultantActivitySchema = z.object({
  userId: uuidSchema,
  fullName: z.string(),
  auditsCompleted: z.number().int().nonnegative(),
  zonesCovered: z.number().int().nonnegative(),
  photosCaptured: z.number().int().nonnegative(),
  averageDurationMinutes: z.number().nonnegative().nullable(),
  lastActiveAt: isoDateTimeSchema.nullable(),
});
export type ConsultantActivity = z.infer<typeof consultantActivitySchema>;

export const zoneLeaderActivitySchema = z.object({
  userId: uuidSchema,
  fullName: z.string(),
  crossAuditsCompleted: z.number().int().nonnegative(),
  actionsSubmitted: z.number().int().nonnegative(),
  averageResponseHours: z.number().nonnegative().nullable(),
  lastActiveAt: isoDateTimeSchema.nullable(),
});
export type ZoneLeaderActivity = z.infer<typeof zoneLeaderActivitySchema>;
