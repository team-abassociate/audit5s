import { Injectable } from '@nestjs/common';
import type {
  ResponseValue,
  ScoreSummary,
  SSection,
  SectionScorePayload,
  ScoreTotalsPayload,
} from '@audit5s/contracts';
import {
  rollUpBreakdowns,
  scoreZone,
  type ScopeContext,
  type ScoreBreakdown,
  type ScoreTotals,
} from '@audit5s/domain';
import { AuditsRepository } from './audits.repository';

/**
 * The server's authoritative recomputation (D5).
 *
 * It reads `section` and `value` from `question_response` and hands them to
 * `packages/domain`'s `scoreZone`. It does **not** sum the stored `numeric_score` in SQL,
 * and that is the point: the device computed its number with the same function, so the two
 * agree because they are the same code, not because two implementations were written
 * carefully. The Phase 3 acceptance row — "scores computed on-device match the server
 * exactly" — is a property of that arrangement rather than of a tolerance.
 *
 * `numeric_score` still exists, still carries QR-1, and is what analytics aggregates in
 * SQL. It is a denormalisation of the enum, not a second source of truth for it.
 */
@Injectable()
export class ScoringService {
  constructor(private readonly repository: AuditsRepository) {}

  /**
   * Recomputes every score under one audit and persists them: the audit totals, each
   * Zone's totals and the materialised per-S rows.
   *
   * Called on Zone completion, on audit completion and after a post-completion override —
   * every path that can change what was answered.
   */
  async recompute(scope: ScopeContext, auditId: string): Promise<Map<string, ScoreBreakdown>> {
    const { audit: auditTotals, zones: breakdowns } = await this.summarise(scope, auditId);

    await this.repository.writeScores(scope, auditId, {
      audit: auditTotals.totals,
      zones: [...breakdowns.entries()].map(([auditZoneId, breakdown]) => ({
        auditZoneId,
        totals: breakdown.totals,
        sections: breakdown.sections.map((section) => ({
          section: section.section,
          applicableQuestions: section.applicableQuestions,
          naQuestions: section.naQuestions,
          rawScore: section.rawScore,
          maxScore: section.maxScore,
          scorePercentage: section.scorePercentage,
        })),
      })),
    });

    return breakdowns;
  }

  /**
   * The score of one audit, recomputed from its responses rather than read from the cache
   * columns. `GET /audits/{id}/summary` serves this, so a Consultant's read model and the
   * number the server stores can never quietly diverge.
   */
  async summarise(
    scope: ScopeContext,
    auditId: string,
  ): Promise<{ audit: ScoreBreakdown; zones: Map<string, ScoreBreakdown> }> {
    const zones = await this.repository.listZones(scope, auditId);
    const responses = await this.repository.listResponses(scope, auditId);

    const byZone = new Map<string, ScorableRow[]>();
    for (const zone of zones) byZone.set(zone.id, []);
    for (const response of responses) {
      byZone.get(response.auditZoneId)?.push({ section: response.section, value: response.value });
    }

    const zoneBreakdowns = new Map<string, ScoreBreakdown>();
    for (const zone of zones) {
      zoneBreakdowns.set(zone.id, scoreZone(byZone.get(zone.id) ?? []));
    }

    return { audit: rollUpBreakdowns([...zoneBreakdowns.values()]), zones: zoneBreakdowns };
  }
}

/** What the pure scorer needs from a stored response, and nothing more. */
type ScorableRow = { section: SSection; value: ResponseValue };

/** The wire shape of §8.6, from the domain breakdown. One conversion, used everywhere. */
export function toScoreSummary(
  auditId: string,
  auditZoneId: string | null,
  breakdown: ScoreBreakdown,
): ScoreSummary {
  return {
    auditId,
    auditZoneId,
    totals: toTotals(breakdown.totals),
    sections: breakdown.sections.map(toSection),
  };
}

export function toTotals(totals: ScoreTotals): ScoreTotalsPayload {
  return {
    applicableQuestions: totals.applicableQuestions,
    naQuestions: totals.naQuestions,
    rawScore: totals.rawScore,
    maxScore: totals.maxScore,
    scorePercentage: totals.scorePercentage,
  };
}

/** The section rows use the short keys §8.6 prints, so one renderer serves every context. */
export function toSection(section: ScoreBreakdown['sections'][number]): SectionScorePayload {
  return {
    section: section.section,
    applicable: section.applicableQuestions,
    na: section.naQuestions,
    raw: section.rawScore,
    max: section.maxScore,
    pct: section.scorePercentage,
  };
}
