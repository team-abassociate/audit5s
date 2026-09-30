import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SYSTEM_SCOPE } from './common/auth/system-scope';
import { CorrectiveActionsRepository } from './modules/corrective-actions/corrective-actions.repository';
import { CorrectiveActionsService } from './modules/corrective-actions/corrective-actions.service';

/**
 * Raise the corrective actions that completed audits should have had and did not.
 *
 * **Why this exists.** Until 2026-09-30 an audit's corrective actions were raised on the
 * completing transaction under the *auditor's* RLS, and `materialize` joins `zone`, which
 * admits only the actor's Units. A Consultant holds a Unit through an open assignment or
 * an open audit (0032); completing their last open audit there, with the assignment
 * already closed, took the Unit away on that same transaction. The join came back empty,
 * nothing failed, and the audit completed with its nonconformities and no actions — so
 * its reports printed every finding without a link to close it. Completion now raises
 * them as the system; this repairs the audits completed before that.
 *
 * It runs the service, not SQL: `CorrectiveActionsService.raiseMissing` is the R-31
 * cascade on its own transaction — `materialize` opening exactly what is missing, the
 * audit rolling back from CLOSED to CORRECTIVE_ACTION_OPEN through §7.1's edges — plus
 * a notification to each Zone Leader and an audit-log entry. Idempotent.
 *
 * **It does not touch reports.** A report's links are frozen into it (R-14), so a report
 * issued before the repair still has no links. Regenerate those afterwards:
 *
 *   node dist/reissue-report-links.js --missing-links --commit
 *
 * Usage (on the VPS, with the API's environment):
 *
 *   node dist/raise-missing-corrective-actions.js [--audit=<id>] [--commit]
 *
 *     --audit=<id>  Only this audit. Default: every completed audit that needs it.
 *     --commit      Actually do it. Without this nothing is written.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const only = argv.find((arg) => arg.startsWith('--audit='))?.slice('--audit='.length);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const repository = app.get(CorrectiveActionsRepository);
    const service = app.get(CorrectiveActionsService);

    const affected = (await repository.findAuditsWithUnraisedFindings(SYSTEM_SCOPE)).filter(
      (row) => !only || row.auditId === only,
    );

    if (affected.length === 0) {
      console.warn('No completed audit is missing a corrective action.');
      return;
    }

    console.warn(`${affected.length} audit(s) missing corrective actions:\n`);
    for (const row of affected) {
      console.warn(
        `  ${row.auditId}  ${row.unitName} · ${row.auditorName ?? '?'} · ` +
          `completed ${row.completedAt?.toISOString().slice(0, 10) ?? '?'} · ${row.status} · ` +
          `${row.findings} finding(s), ${row.suggestions} overall suggestion(s) without an action`,
      );
    }

    if (!commit) {
      console.warn(
        '\nDry run — nothing was written. Re-run with --commit to raise them. Each Zone ' +
          'Leader is notified of the actions raised for them.',
      );
      return;
    }

    let failed = 0;
    for (const row of affected) {
      process.stderr.write(`  ${row.auditId} -> `);
      try {
        const { opened, auditStatus } = await service.raiseMissing(SYSTEM_SCOPE, row.auditId);
        console.warn(`${opened.length} action(s) raised; audit is ${auditStatus}`);
      } catch (error) {
        failed += 1;
        console.warn(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.warn(
      '\nNow regenerate the reports so they carry the links:\n' +
        '  node dist/reissue-report-links.js --missing-links --commit',
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
