import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type Audit,
  type NotificationPage,
  type NotificationPreferences,
} from '@audit5s/contracts';
import { PushChannel } from '../src/infrastructure/push/push-channel';
import {
  MessageChannel,
  type OutboundMessage,
} from '../src/infrastructure/messaging/message-channel';
import { NotificationWorker } from '../src/modules/notifications/notification.worker';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';
import { completedWalkBy, drainNotifications, forgetQueuedNotifications, submit } from './corrective-fixtures';

/**
 * Notifications (§4.2, §5.9, §8.10).
 *
 * The API process in these suites registers no workers, exactly as in production — only
 * `worker-general` does — so each test hands the queued events to a worker itself. That
 * keeps the point of R-2 visible: the domain write enqueues, and delivery happens
 * elsewhere, later, and cannot undo the write.
 */

let world: TestWorld;
const base = API_BASE_PATH;
const DEVICE = '01930000-0000-7000-8000-0000000cb001';
let consultantToken: string;
let worker: NotificationWorker;
const seen = new Set<string>();

class FakeChannel extends MessageChannel {
  readonly sent: OutboundMessage[] = [];
  constructor(
    readonly configured: boolean,
    private readonly down = false,
  ) {
    super();
  }
  send(message: OutboundMessage): Promise<{ providerMessageId: string | null }> {
    if (this.down) return Promise.reject(new Error('provider unavailable (503)'));
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `msg-${this.sent.length}` });
  }
}

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE);
  worker = world.app.get(NotificationWorker);
  await forgetQueuedNotifications(world);
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

function walkBy(nonconformities: number) {
  return completedWalkBy(world, {
    token: consultantToken,
    deviceId: DEVICE,
    unitId: world.unitA,
    zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
    nonconformities,
  });
}

async function notificationsFor(userId: string, eventId?: string) {
  const { rows } = await world.owner.query(
    `SELECT n.id, n.event_type, n.title, n.body,
            coalesce(json_agg(json_build_object('channel', d.channel, 'status', d.status,
                     'fallback', d.fallback_of_delivery_id IS NOT NULL) ORDER BY d.created_at)
                     FILTER (WHERE d.id IS NOT NULL), '[]') AS deliveries
       FROM notification n LEFT JOIN notification_delivery d ON d.notification_id = n.id
      WHERE n.recipient_user_id = $1 AND ($2::uuid IS NULL OR n.event_id = $2::uuid)
      GROUP BY n.id ORDER BY n.created_at`,
    [userId, eventId ?? null],
  );
  return rows as Array<{
    id: string;
    event_type: string;
    body: string;
    deliveries: Array<{ channel: string; status: string; fallback: boolean }>;
  }>;
}

describe('fan-out (§4.2)', () => {
  it('tells the Super Admin, the Coordinator and the assigned Zone Leader — not the auditor', async () => {
    const { auditId } = await walkBy(2);
    const events = await drainNotifications(world, worker, seen);
    const completed = events.find((event) => event.type === 'AUDIT_COMPLETED' && event.resourceId === auditId)!;
    expect(completed).toBeDefined();

    for (const role of ['SUPER_ADMIN', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      const mine = await notificationsFor(world.actors[role].userId, completed.eventId);
      expect(mine, role).toHaveLength(1);
      expect(mine[0]!.body).toBe('Walk-by audit completed — 2 corrective actions opened.');
    }
    expect(await notificationsFor(world.actors.CONSULTANT.userId, completed.eventId)).toHaveLength(0);
  });

  it('records WhatsApp as SKIPPED, and its SMS fallback too, with no provider wired', async () => {
    const { auditId } = await walkBy(1);
    const events = await drainNotifications(world, worker, seen);
    const completed = events.find((event) => event.type === 'AUDIT_COMPLETED' && event.resourceId === auditId)!;
    const [leader] = await notificationsFor(world.actors.ZONE_LEADER.userId, completed.eventId);
    expect(leader!.deliveries).toEqual([
      { channel: 'IN_APP', status: 'DELIVERED', fallback: false },
      { channel: 'WHATSAPP', status: 'SKIPPED', fallback: false },
      { channel: 'SMS', status: 'SKIPPED', fallback: true },
    ]);
  });

  it('notifies the Super Admin of each submission, and not the submitter', async () => {
    const { actions } = await walkBy(1);
    await drainNotifications(world, worker, seen);
    await submit(world, world.actors.ZONE_LEADER.accessToken, actions[0]!.id, {
      option: 'NOT_POSSIBLE',
      explanation: 'Needs a capital purchase',
    });
    const events = await drainNotifications(world, worker, seen);
    const submitted = events.find((event) => event.type === 'CORRECTIVE_ACTION_SUBMITTED')!;
    expect(await notificationsFor(world.actors.SUPER_ADMIN.userId, submitted.eventId)).toHaveLength(1);
    expect(await notificationsFor(world.actors.ZONE_LEADER.userId, submitted.eventId)).toHaveLength(0);
  });

  it('tells the Super Admin when an audit is paused (N7)', async () => {
    const auditId = randomUUID();
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: { id: auditId, auditType: 'WALK_BY', unitId: world.unitA, deviceId: DEVICE },
    });
    const { captureEvidence } = await import('./harness');
    await captureEvidence(world, { token: consultantToken, evidenceId: randomUUID(), auditId, deviceId: DEVICE });
    await world.request('POST', `${base}/audits/${auditId}/start`, { token: consultantToken, body: { deviceId: DEVICE } });
    const paused = await world.request('POST', `${base}/audits/${auditId}/pause`, {
      token: consultantToken,
      body: { reason: 'Shift change' },
    });
    expect((paused.body as Audit).status).toBe('PAUSED');

    const events = await drainNotifications(world, worker, seen);
    const pause = events.find((event) => event.type === 'AUDIT_PAUSED' && event.resourceId === auditId)!;
    const [admin] = await notificationsFor(world.actors.SUPER_ADMIN.userId, pause.eventId);
    expect(admin!.body).toBe('Walk-by audit was paused: Shift change. Nothing was discarded.');
  });
});

describe('§5.9 — WhatsApp down, SMS fallback', () => {
  it('records the failure and a second, fallback delivery; the audit is untouched', async () => {
    const whatsapp = new FakeChannel(true, true);
    const sms = new FakeChannel(true);
    const failing = new NotificationWorker(
      world.app.get(NotificationsRepository),
      world.app.get(PushChannel),
      whatsapp,
      sms,
    );

    const { auditId, actions } = await walkBy(1);
    const events = await drainNotifications(world, failing, seen);
    const completed = events.find((event) => event.type === 'AUDIT_COMPLETED' && event.resourceId === auditId)!;

    const [leader] = await notificationsFor(world.actors.ZONE_LEADER.userId, completed.eventId);
    expect(leader!.deliveries).toEqual([
      { channel: 'IN_APP', status: 'DELIVERED', fallback: false },
      { channel: 'WHATSAPP', status: 'FAILED', fallback: false },
      { channel: 'SMS', status: 'SENT', fallback: true },
    ]);
    expect(sms.sent.map((message) => message.toE164)).toContain('+919000000104');

    // The domain transaction committed long before any provider was called.
    const audit = await world.request('GET', `${base}/audits/${auditId}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect((audit.body as Audit).status).toBe('CORRECTIVE_ACTION_OPEN');
    expect(actions).toHaveLength(1);
  });

  it('retries a failed SMS through the job, and still sends nothing twice', async () => {
    const down = new FakeChannel(true, true);
    const flaky = new NotificationWorker(world.app.get(NotificationsRepository), world.app.get(PushChannel), down, down);
    await walkBy(1);
    const [job] = (await world.owner.query(
      `SELECT data FROM pgboss.job WHERE name = 'notification.send' ORDER BY created_on DESC LIMIT 1`,
    )).rows as Array<{ data: Parameters<NotificationWorker['handle']>[0] }>;
    await expect(flaky.handle(job!.data)).rejects.toThrow(/delivery attempt/);

    // The redelivery finds its rows: one notification per recipient, the SMS attempted again.
    const recovered = new FakeChannel(true);
    const healthy = new NotificationWorker(world.app.get(NotificationsRepository), world.app.get(PushChannel), down, recovered);
    await healthy.handle(job!.data);
    const leader = await notificationsFor(world.actors.ZONE_LEADER.userId, job!.data.eventId);
    expect(leader).toHaveLength(1);
    expect(leader[0]!.deliveries.find((delivery) => delivery.channel === 'SMS')!.status).toBe('SENT');
    // One SMS per recipient whose WhatsApp failed — and exactly one to each.
    expect(recovered.sent.filter((message) => message.toE164 === '+919000000104')).toHaveLength(1);
  });
});

describe('the notification centre (§8.10)', () => {
  it('lists the caller’s own, counts unread, and marks read', async () => {
    const token = world.actors.ZONE_LEADER.accessToken;
    const page = await world.request('GET', `${base}/notifications?unread=true`, { token });
    expect(page.status).toBe(200);
    const unread = page.body as NotificationPage;
    expect(unread.unreadCount).toBeGreaterThan(0);
    const first = unread.data[0]!;

    const read = await world.request('POST', `${base}/notifications/${first.id}/read`, { token });
    expect(read.status).toBe(200);
    expect((read.body as { readAt: string | null }).readAt).not.toBeNull();

    // Someone else's notification reads as absent (AZ-3).
    const foreign = await world.request('POST', `${base}/notifications/${first.id}/read`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(foreign.status).toBe(404);

    const all = await world.request('POST', `${base}/notifications/read-all`, { token });
    expect(all.status).toBe(200);
    const after = await world.request('GET', `${base}/notifications`, { token });
    expect((after.body as NotificationPage).unreadCount).toBe(0);
  });

  it('pages newest first by cursor', async () => {
    const token = world.actors.SUPER_ADMIN.accessToken;
    const first = (await world.request('GET', `${base}/notifications?limit=1`, { token })).body as NotificationPage;
    expect(first.nextCursor).not.toBeNull();
    const second = (await world.request('GET', `${base}/notifications?limit=1&cursor=${first.nextCursor}`, { token }))
      .body as NotificationPage;
    expect(Date.parse(second.data[0]!.createdAt)).toBeLessThanOrEqual(Date.parse(first.data[0]!.createdAt));
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });
});

describe('preferences (§5.9, §8.10)', () => {
  it('fills every cell, keeps IN_APP on, and routes a disabled WhatsApp to SMS', async () => {
    const token = world.actors.ZONE_LEADER.accessToken;
    const grid = (await world.request('GET', `${base}/notification-preferences`, { token }))
      .body as NotificationPreferences;
    expect(grid.preferences.every((cell) => cell.enabled)).toBe(true);

    const saved = await world.request('PUT', `${base}/notification-preferences`, {
      token,
      body: {
        preferences: [
          { eventType: 'AUDIT_COMPLETED', channel: 'WHATSAPP', enabled: false },
          { eventType: 'AUDIT_COMPLETED', channel: 'IN_APP', enabled: false },
        ],
      },
    });
    expect(saved.status).toBe(200);
    const cells = (saved.body as NotificationPreferences).preferences.filter(
      (cell) => cell.eventType === 'AUDIT_COMPLETED',
    );
    expect(cells.find((cell) => cell.channel === 'WHATSAPP')!.enabled).toBe(false);
    expect(cells.find((cell) => cell.channel === 'IN_APP')!.enabled).toBe(true);

    const sms = new FakeChannel(true);
    const whatsapp = new FakeChannel(true);
    const routed = new NotificationWorker(world.app.get(NotificationsRepository), world.app.get(PushChannel), whatsapp, sms);
    const { auditId } = await walkBy(1);
    const events = await drainNotifications(world, routed, seen);
    const completed = events.find((event) => event.type === 'AUDIT_COMPLETED' && event.resourceId === auditId)!;
    const [leader] = await notificationsFor(world.actors.ZONE_LEADER.userId, completed.eventId);
    expect(leader!.deliveries.map((delivery) => `${delivery.channel}:${delivery.status}`)).toEqual([
      'IN_APP:DELIVERED',
      'SMS:SENT',
    ]);
  });
});
