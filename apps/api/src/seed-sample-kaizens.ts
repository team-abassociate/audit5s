import { randomUUID } from 'node:crypto';
import type { Logger, INestApplicationContext } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { units, unitMemberships, users, zones, type Database } from '@audit5s/db';
import type { KaizenFields, KaizenReviewDecision, Role } from '@audit5s/contracts';
import { formatRupees, grantFor, loginIdCandidate, type ScopeContext } from '@audit5s/domain';
import { KaizensService } from './modules/kaizens/kaizens.service';
import type { PasswordService } from './modules/auth/password.service';

/**
 * Sample Kaizens for a **development** database (plans/kaizen-module.md §5): one sample Unit
 * with three Zones, three Zone Leaders and a Coordinator, and Kaizens in every status, so
 * the field app and the portal have something real to show the moment `pnpm seed` finishes.
 *
 * Never in production: `seed.ts` calls this only when `NODE_ENV` is `development`, and the
 * seed runs on every deploy. The Unit, Zones and people are written with the owner
 * connection, as the test harness does; every Kaizen goes through `KaizensService` as its
 * own author and Coordinator, so numbering, triggers, reviews and `audit_log` are the real
 * ones. Runs once: a database that already has the sample Unit is left alone.
 */

export const SAMPLE_UNIT_NAME = 'Bhosari Plant 2 (sample)';
/** Every sample person signs in with this. Development only. */
export const SAMPLE_PASSWORD = 'Kaizen@2026';

const ZONES = [
  { code: 'Z-07', name: 'Press Shop', department: 'Press' },
  { code: 'Z-03', name: 'Paint Shop', department: 'Paint' },
  { code: 'Z-11', name: 'Assembly', department: 'Assembly' },
] as const;

const LEADERS = [
  { fullName: 'Sunita Kale', phone: '+919999000071', zone: 'Z-07' },
  { fullName: 'Rahul Pawar', phone: '+919999000072', zone: 'Z-03' },
  { fullName: 'Anjali Deshmukh', phone: '+919999000073', zone: 'Z-11' },
] as const;
const COORDINATOR = { fullName: 'Meera Joshi', phone: '+919999000070' };

type Outcome = 'DRAFT' | 'SUBMITTED' | KaizenReviewDecision | 'RESUBMITTED';

/** The sheets: every status, savings from none to crores, one sent back and fixed. */
const KAIZENS: Array<{ leader: number; outcome: Outcome; comment?: string; sheet: KaizenFields }> = [
  {
    leader: 0,
    outcome: 'APPROVED',
    comment: 'Good. Deploy the clamps on P-05 next.',
    sheet: sheet('250T Press P-04', 'Line 3', 'Die change cut from 42 to 18 min with quick-release clamps', 360000, ['WAITING_TIME', 'MOTION'], ['PRODUCTIVITY', 'COST']),
  },
  {
    leader: 0,
    outcome: 'SENT_BACK',
    comment: 'Add the before and after changeover times from the logbook, not estimates.',
    sheet: sheet('Blanking die BD-7', 'Line 1', 'Poka-yoke pin on the blanking die stops reversed blanks', 240000, ['DEFECTS'], ['QUALITY']),
  },
  {
    leader: 0,
    outcome: 'DRAFT',
    sheet: { machine: 'Line 3', theme: 'Colour-coded shadow board for die tools' },
  },
  {
    leader: 1,
    outcome: 'SUBMITTED',
    sheet: sheet('Booth 2', 'Paint line', 'Masking jig for bumper brackets halves overspray rework', 1240000, ['DEFECTS', 'EXTRA_PROCESSING'], ['QUALITY', 'COST', 'MORALE']),
  },
  {
    leader: 1,
    outcome: 'REJECTED',
    comment: 'Capex, not a Kaizen. Raise it through the budget request.',
    sheet: sheet('Coil store', 'Store', 'Second forklift for the coil store', 650000, ['TRANSPORTATION'], ['DELIVERY']),
  },
  {
    leader: 2,
    outcome: 'APPROVED',
    sheet: sheet('Door line DL-1', 'Assembly', 'Kitting trolley for the door trim line', 72000, ['MOTION', 'INVENTORY'], ['PRODUCTIVITY', 'DELIVERY']),
  },
  {
    leader: 2,
    outcome: 'RESUBMITTED',
    comment: 'Say how the saving was worked out.',
    sheet: sheet('Torque station T-4', 'Assembly', 'Coolant drip tray under the torque station ends the slip hazard', null, ['DEFECTS'], ['SAFETY']),
  },
  {
    leader: 2,
    outcome: 'SUBMITTED',
    sheet: sheet('Line 2', 'Assembly', 'Scrap bin moved beside the trim station, 140 m of walking a shift removed', 108000, ['MOTION'], ['PRODUCTIVITY']),
  },
];

export async function seedSampleKaizens(
  app: INestApplicationContext,
  db: Database,
  passwords: PasswordService,
  superAdminId: string,
  logger: Logger,
): Promise<void> {
  const [existing] = await db.select({ id: units.id }).from(units).where(eq(units.name, SAMPLE_UNIT_NAME)).limit(1);
  if (existing) {
    logger.log(`Sample Kaizens: already seeded in "${SAMPLE_UNIT_NAME}"`);
    return;
  }

  const passwordHash = await passwords.hash(SAMPLE_PASSWORD);
  const people = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
    const [unit] = await tx.insert(units).values({ name: SAMPLE_UNIT_NAME }).returning({ id: units.id });
    const unitId = unit!.id;

    const person = async (fullName: string, phone: string, role: Role) => {
      const [row] = await tx
        .insert(users)
        .values({
          loginId: loginIdCandidate(fullName, phone, 0),
          fullName,
          phoneE164: phone,
          role,
          passwordHash,
          mustResetPassword: false,
          status: 'ACTIVE',
        })
        .returning({ id: users.id, loginId: users.loginId });
      await tx.insert(unitMemberships).values({ userId: row!.id, unitId, role, assignedByUserId: superAdminId });
      return row!;
    };

    const coordinator = await person(COORDINATOR.fullName, COORDINATOR.phone, 'COORDINATOR');
    const leaders = [];
    for (const [index, leader] of LEADERS.entries()) {
      const user = await person(leader.fullName, leader.phone, 'ZONE_LEADER');
      const zone = ZONES.find((z) => z.code === leader.zone)!;
      const [row] = await tx
        .insert(zones)
        .values({ unitId, code: zone.code, name: zone.name, departmentHint: zone.department, zoneLeaderId: user.id, sortOrder: index })
        .returning({ id: zones.id });
      leaders.push({ ...user, zoneId: row!.id });
    }
    return { unitId, coordinator, leaders };
  });

  const kaizens = app.get(KaizensService);
  const scopeOf = (userId: string, role: Role): ScopeContext => ({
    actor: { userId, role, activeUnitId: people.unitId, unitIds: [people.unitId], deviceId: null },
    resolver: grantFor(role, 'kaizen:read')!.resolver,
  });
  const coordinator = scopeOf(people.coordinator.id, 'COORDINATOR');

  for (const entry of KAIZENS) {
    const leader = people.leaders[entry.leader]!;
    const author = scopeOf(leader.id, 'ZONE_LEADER');
    const created = await kaizens.create(author, { id: uuidv7(), zoneId: leader.zoneId, ...entry.sheet });
    if (entry.outcome === 'DRAFT') continue;

    await kaizens.submit(author, created.id, { submissionId: randomUUID() });
    if (entry.outcome === 'SUBMITTED') continue;

    const decision = entry.outcome === 'RESUBMITTED' ? 'SENT_BACK' : entry.outcome;
    await kaizens.review(coordinator, created.id, { decision, comment: entry.comment ?? null });
    if (entry.outcome === 'RESUBMITTED') {
      await kaizens.submit(author, created.id, { submissionId: randomUUID() });
    }
  }

  logger.log(
    `Sample Kaizens: ${KAIZENS.length} in "${SAMPLE_UNIT_NAME}". Sign in as ` +
      `${people.coordinator.loginId} (Coordinator) or ${people.leaders.map((l) => l.loginId).join(', ')} ` +
      `(Zone Leaders), password ${SAMPLE_PASSWORD}`,
  );
}

function sheet(
  machine: string,
  lineArea: string,
  theme: string,
  annualSaving: number | null,
  wastes: KaizenFields['wastes'],
  parameters: KaizenFields['parameters'],
): KaizenFields {
  return {
    machine,
    lineArea,
    implementedOn: new Date().toISOString().slice(0, 10),
    teamMembers: 'Shift A team',
    theme,
    target: 'Within the quarter',
    problem5w1h: `${theme}: what was happening, where, when and how often, before the change.`,
    rootCause4m: 'Method',
    analysis7qc: 'Check sheet over two weeks',
    countermeasure: theme,
    wastes,
    parameters,
    horizontalDeployment: true,
    benefits: annualSaving ? `Saving worked out on the sheet: ${formatRupees(annualSaving)} a year.` : 'Safer floor; no saving claimed.',
    annualSaving,
    ideaBy: 'Shift A team',
    implementedBy: 'Maintenance',
  };
}
