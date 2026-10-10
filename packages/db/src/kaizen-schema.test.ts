import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { APP_URL, IDS, OWNER_URL, asActor, connect, migrate, resetFixtures, seedFixtures } from './test-support';

/**
 * Migration 0044's guarantees (R-48), asserted against a real PostgreSQL.
 *
 * The services will never issue most of these statements. That is the point: the number,
 * the state machine's edges, the append-only review history and who sees whose Kaizen
 * hold for a statement the services never would.
 */

let owner: Client;
let app: Client;

const K = {
  zoneB: '01930000-0000-7000-8000-00000000a001',
  zoneArchived: '01930000-0000-7000-8000-00000000a002',
  zoneUnitB: '01930000-0000-7000-8000-00000000a003',
  leaderTwo: '01930000-0000-7000-8000-00000000a004',
  coordinatorB: '01930000-0000-7000-8000-00000000a005',
  kaizen1: '01930000-0000-7000-8000-00000000b001',
  kaizen2: '01930000-0000-7000-8000-00000000b002',
  kaizenOther: '01930000-0000-7000-8000-00000000b003',
  photo1: '01930000-0000-7000-8000-00000000c001',
  photo2: '01930000-0000-7000-8000-00000000c002',
};

const SHEET = `machine = 'Press 4', line_area = 'Line 2', implemented_on = '2026-10-01',
  team_members = 'Ravi, Sita', theme = 'Faster changeover', problem_5w1h = 'Changeover 20 min',
  countermeasure = 'Quick-release clamps', horizontal_deployment = true,
  benefits = 'Changeover 8 min', root_cause_4m = 'Method', idea_by = 'Ravi',
  implemented_by = 'Sita', annual_saving = 108000`;

beforeAll(async () => {
  migrate();
  owner = await connect(OWNER_URL);
  app = await connect(APP_URL);
});

afterAll(async () => {
  await owner?.end();
  await app?.end();
});

beforeEach(async () => {
  await resetFixtures(owner);
  await seedFixtures(owner);
  await owner.query(
    `INSERT INTO zone (id, unit_id, code, name, department_hint) VALUES
       ($1, $4, 'Z-01', 'Press', 'Production'),
       ($2, $4, 'Z-07', 'Dispatch', NULL),
       ($3, $5, 'Z-01', 'Stores', NULL)`,
    [IDS.zoneA, K.zoneB, K.zoneUnitB, IDS.unitA, IDS.unitB],
  );
  await owner.query(
    `INSERT INTO zone (id, unit_id, code, name, archived_at) VALUES ($1, $2, 'Z-09', 'Old', now())`,
    [K.zoneArchived, IDS.unitA],
  );
  await owner.query(
    `INSERT INTO "user" (id, login_id, full_name, phone_e164, role, password_hash, status)
     VALUES ($1,'ZL0005','Leader Two','+919000000005','ZONE_LEADER','x','ACTIVE'),
            ($2,'CO0006','Coord B','+919000000006','COORDINATOR','x','ACTIVE')`,
    [K.leaderTwo, K.coordinatorB],
  );
  await owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
     VALUES ($1, $3, 'ZONE_LEADER', $5), ($2, $4, 'COORDINATOR', $5)`,
    [K.leaderTwo, K.coordinatorB, IDS.unitA, IDS.unitB, IDS.superAdmin],
  );
});

/** A Zone Leader creates a draft, as the API does: id and Zone only, unit from the trigger. */
function create(id: string, zoneId: string, author = IDS.zoneLeaderA, unitClaim = IDS.unitA) {
  return asActor(app, author, 'ZONE_LEADER', () =>
    app.query(
      `INSERT INTO kaizen (id, unit_id, zone_id, author_user_id, author_name, kaizen_seq, kaizen_no)
       VALUES ($1, $2, $3, $4, 'Leader', 0, '') RETURNING unit_id, kaizen_no`,
      [id, unitClaim, zoneId, author],
    ),
  );
}

function submit(id: string, author = IDS.zoneLeaderA) {
  return asActor(app, author, 'ZONE_LEADER', () =>
    app.query(
      `UPDATE kaizen SET ${SHEET}, status = 'SUBMITTED', submitted_at = now(),
         last_submission_id = gen_random_uuid() WHERE id = $1`,
      [id],
    ),
  );
}

/** The API's review transaction: the decision first, then the move it makes. */
function review(id: string, decision: string, comment: string | null, actor = IDS.coordinatorA) {
  return asActor(app, actor, 'COORDINATOR', async () => {
    await app.query(
      `INSERT INTO kaizen_review (kaizen_id, reviewer_user_id, reviewer_name, reviewer_role, decision, comment)
       VALUES ($1, $2, 'Coord One', 'COORDINATOR', $3, $4)`,
      [id, actor, decision, comment],
    );
    return app.query(`UPDATE kaizen SET status = $2 WHERE id = $1`, [id, decision]);
  });
}

function visibleTo(actor: string, role: string): Promise<string[]> {
  return asActor(app, actor, role, async () => {
    const { rows } = await app.query(`SELECT id FROM kaizen ORDER BY id`);
    return rows.map((row) => row.id as string);
  });
}

describe('numbering', () => {
  it('numbers by Zone code and a running count per Unit, and takes the Unit from the Zone', async () => {
    const first = await create(K.kaizen1, IDS.zoneA, IDS.zoneLeaderA, IDS.unitB);
    const second = await create(K.kaizen2, K.zoneB, K.leaderTwo);
    expect(first.rows[0]).toEqual({ unit_id: IDS.unitA, kaizen_no: 'KZ-Z01-001' });
    // The count is the Unit's, across Zones and authors, though neither leader sees the other's.
    expect(second.rows[0].kaizen_no).toBe('KZ-Z07-002');
  });

  it('refuses an archived Zone', async () => {
    await expect(create(K.kaizen1, K.zoneArchived)).rejects.toThrow(/not an active Zone/);
  });

  it('keeps the number, Zone and author fixed', async () => {
    await create(K.kaizen1, IDS.zoneA);
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(`UPDATE kaizen SET kaizen_no = 'KZ-X' WHERE id = $1`, [K.kaizen1]),
      ),
    ).rejects.toThrow(/fixed/);
  });
});

describe('who sees which Kaizen', () => {
  beforeEach(async () => {
    await create(K.kaizen1, IDS.zoneA);
    await create(K.kaizen2, K.zoneB, K.leaderTwo);
  });

  it('shows a Zone Leader their own only', async () => {
    expect(await visibleTo(IDS.zoneLeaderA, 'ZONE_LEADER')).toEqual([K.kaizen1]);
  });

  it("shows a Coordinator and a Consultant the Unit's, and another Unit's Coordinator none", async () => {
    expect(await visibleTo(IDS.coordinatorA, 'COORDINATOR')).toEqual([K.kaizen1, K.kaizen2]);
    expect(await visibleTo(IDS.consultant, 'CONSULTANT')).toEqual([K.kaizen1, K.kaizen2]);
    expect(await visibleTo(K.coordinatorB, 'COORDINATOR')).toEqual([]);
  });

  it("refuses a Zone Leader writing another leader's Kaizen", async () => {
    const result = await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`UPDATE kaizen SET machine = 'x' WHERE id = $1`, [K.kaizen2]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('refuses a Coordinator creating one', async () => {
    await expect(
      asActor(app, IDS.coordinatorA, 'COORDINATOR', () =>
        app.query(
          `INSERT INTO kaizen (id, unit_id, zone_id, author_user_id, author_name, kaizen_seq, kaizen_no)
           VALUES ($1, $2, $3, $4, 'C', 0, '')`,
          [K.kaizenOther, IDS.unitA, IDS.zoneA, IDS.coordinatorA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('the state machine', () => {
  beforeEach(async () => {
    await create(K.kaizen1, IDS.zoneA);
  });

  it('refuses submitting a sheet with a required step empty', async () => {
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(`UPDATE kaizen SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`, [
          K.kaizen1,
        ]),
      ),
    ).rejects.toThrow(/kaizen_submitted_is_complete/);
  });

  it('refuses a move that is not an edge', async () => {
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(`UPDATE kaizen SET ${SHEET}, status = 'APPROVED', submitted_at = now() WHERE id = $1`, [
          K.kaizen1,
        ]),
      ),
    ).rejects.toThrow(/not a move/);
  });

  it('freezes the sheet while it awaits review', async () => {
    await submit(K.kaizen1);
    const result = await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`UPDATE kaizen SET machine = 'Press 5' WHERE id = $1`, [K.kaizen1]),
    );
    // The author's policy no longer reaches a SUBMITTED row; the owner's statement meets the trigger.
    expect(result.rowCount).toBe(0);
    await expect(
      owner.query(`UPDATE kaizen SET machine = 'Press 5' WHERE id = $1`, [K.kaizen1]),
    ).rejects.toThrow(/cannot be edited/);
  });

  it('refuses a decision with no review row behind it', async () => {
    await submit(K.kaizen1);
    await expect(
      asActor(app, IDS.coordinatorA, 'COORDINATOR', () =>
        app.query(`UPDATE kaizen SET status = 'APPROVED' WHERE id = $1`, [K.kaizen1]),
      ),
    ).rejects.toThrow(/review written first/);
  });

  it('goes round send back → resubmit → approve, and then never changes', async () => {
    await submit(K.kaizen1);
    await review(K.kaizen1, 'SENT_BACK', 'Add the saving calculation');
    await submit(K.kaizen1);
    await review(K.kaizen1, 'APPROVED', null);
    const { rows } = await owner.query(`SELECT status FROM kaizen WHERE id = $1`, [K.kaizen1]);
    expect(rows[0].status).toBe('APPROVED');
    await expect(
      owner.query(`UPDATE kaizen SET benefits = 'more' WHERE id = $1`, [K.kaizen1]),
    ).rejects.toThrow(/does not change again/);
  });

  it("refuses another Unit's Coordinator", async () => {
    await submit(K.kaizen1);
    await expect(review(K.kaizen1, 'APPROVED', null, K.coordinatorB)).rejects.toThrow(
      /row-level security/,
    );
  });

  it('never deletes a Kaizen', async () => {
    await expect(owner.query(`DELETE FROM kaizen WHERE id = $1`, [K.kaizen1])).rejects.toThrow();
  });
});

describe('review history', () => {
  beforeEach(async () => {
    await create(K.kaizen1, IDS.zoneA);
    await submit(K.kaizen1);
  });

  it('requires a reason to send back or reject', async () => {
    await expect(review(K.kaizen1, 'REJECTED', '  ')).rejects.toThrow(/kaizen_review_reason_required/);
  });

  it('is append-only', async () => {
    await review(K.kaizen1, 'SENT_BACK', 'Reason');
    await expect(owner.query(`UPDATE kaizen_review SET comment = 'edited'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.query(`DELETE FROM kaizen_review`)).rejects.toThrow(/append-only/);
  });

  it('refuses a Zone Leader reviewing', async () => {
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(
          `INSERT INTO kaizen_review (kaizen_id, reviewer_user_id, reviewer_name, reviewer_role, decision)
           VALUES ($1, $2, 'L', 'ZONE_LEADER', 'APPROVED')`,
          [K.kaizen1, IDS.zoneLeaderA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('photos', () => {
  function addPhoto(id: string, kind: string) {
    return asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(
        `INSERT INTO kaizen_photo (id, kaizen_id, kind, object_key, content_type, byte_size,
                                   checksum_sha256, captured_at, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'image/jpeg', 1000, $5, now(), $6)`,
        [id, K.kaizen1, kind, `unit/x/kaizen/${id}.jpg`, 'a'.repeat(64), IDS.zoneLeaderA],
      ),
    );
  }

  beforeEach(async () => {
    await create(K.kaizen1, IDS.zoneA);
  });

  it('holds one live photo per box, and a replaced one is soft-deleted, never deleted', async () => {
    await addPhoto(K.photo1, 'BEFORE');
    await expect(addPhoto(K.photo2, 'BEFORE')).rejects.toThrow(/kaizen_photo_one_live_per_kind/);
    await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`UPDATE kaizen_photo SET deleted_at = now(), deleted_by_user_id = $2 WHERE id = $1`, [
        K.photo1,
        IDS.zoneLeaderA,
      ]),
    );
    await addPhoto(K.photo2, 'BEFORE');
    await expect(owner.query(`DELETE FROM kaizen_photo WHERE id = $1`, [K.photo1])).rejects.toThrow();
  });

  it('takes no new photo once submitted, but still accepts the upload confirmation', async () => {
    await addPhoto(K.photo1, 'BEFORE');
    await submit(K.kaizen1);
    await expect(addPhoto(K.photo2, 'AFTER')).rejects.toThrow(/draft or sent back/);
    const committed = await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`UPDATE kaizen_photo SET uploaded_at = now(), width = 1920 WHERE id = $1`, [K.photo1]),
    );
    expect(committed.rowCount).toBe(1);
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(`UPDATE kaizen_photo SET deleted_at = now() WHERE id = $1`, [K.photo1]),
      ),
    ).rejects.toThrow(/draft or sent back/);
  });

  it('refuses changing what the photo is', async () => {
    await addPhoto(K.photo1, 'BEFORE');
    await expect(
      owner.query(`UPDATE kaizen_photo SET checksum_sha256 = $2 WHERE id = $1`, [K.photo1, 'b'.repeat(64)]),
    ).rejects.toThrow(/only its upload and removal/);
  });

  it("is visible exactly when its Kaizen is", async () => {
    await addPhoto(K.photo1, 'BEFORE');
    const seen = await asActor(app, K.leaderTwo, 'ZONE_LEADER', () =>
      app.query(`SELECT id FROM kaizen_photo`),
    );
    expect(seen.rowCount).toBe(0);
  });
});

describe('a discarded draft (0045, R-49)', () => {
  function discard(id: string) {
    return asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`UPDATE kaizen SET discarded_at = now() WHERE id = $1`, [id]),
    );
  }

  beforeEach(async () => {
    await create(K.kaizen1, IDS.zoneA);
  });

  it('is a DRAFT only', async () => {
    await submit(K.kaizen1);
    await expect(
      owner.query(`UPDATE kaizen SET discarded_at = now() WHERE id = $1`, [K.kaizen1]),
    ).rejects.toThrow(/only a draft can be discarded/);
  });

  it('never changes again: not edited, not submitted, not un-discarded, not deleted', async () => {
    expect((await discard(K.kaizen1)).rowCount).toBe(1);
    await expect(
      owner.query(`UPDATE kaizen SET machine = 'Press 5' WHERE id = $1`, [K.kaizen1]),
    ).rejects.toThrow(/was discarded/);
    await expect(submit(K.kaizen1)).rejects.toThrow(/was discarded/);
    await expect(
      owner.query(`UPDATE kaizen SET discarded_at = NULL WHERE id = $1`, [K.kaizen1]),
    ).rejects.toThrow(/was discarded/);
    await expect(owner.query(`DELETE FROM kaizen WHERE id = $1`, [K.kaizen1])).rejects.toThrow();
  });

  it('takes no new photo and loses none, but its upload may still be confirmed', async () => {
    const photo = (id: string, kind: string) =>
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(
          `INSERT INTO kaizen_photo (id, kaizen_id, kind, object_key, content_type, byte_size,
                                     checksum_sha256, captured_at, created_by_user_id)
           VALUES ($1, $2, $3, $4, 'image/jpeg', 1000, $5, now(), $6)`,
          [id, K.kaizen1, kind, `unit/x/kaizen/${id}.jpg`, 'a'.repeat(64), IDS.zoneLeaderA],
        ),
      );
    await photo(K.photo1, 'BEFORE');
    await discard(K.kaizen1);
    await expect(photo(K.photo2, 'AFTER')).rejects.toThrow(/discarded draft/);
    await expect(
      owner.query(`UPDATE kaizen_photo SET deleted_at = now() WHERE id = $1`, [K.photo1]),
    ).rejects.toThrow(/discarded draft/);
    const committed = await owner.query(`UPDATE kaizen_photo SET uploaded_at = now() WHERE id = $1`, [K.photo1]);
    expect(committed.rowCount).toBe(1);
  });
});
