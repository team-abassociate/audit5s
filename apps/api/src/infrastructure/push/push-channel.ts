/**
 * The push-notification port (open question Q1).
 *
 * STACK.md keeps FCM behind an adapter, and the Firebase project does not exist yet, so
 * the default this phase runs on is a console implementation — stated plainly rather than
 * disguised as a working integration. What is *not* deferred is the information: a
 * `SYNC_FAILURE` is written to `device_sync_record` and its items to `sync_conflict`, both
 * of which the admin console renders, so the operational half works today and the push
 * half is one adapter away.
 *
 * `notification` / `notification_delivery` (§5.9) arrive with the notifications module in
 * Phase 6. Creating them here would front-run that migration and duplicate its work, so
 * Phase 4 raises the event and the in-app surface is the sync dashboard and the conflict
 * queue rather than a notification centre that does not exist yet.
 */
export interface PushMessage {
  userId: string;
  eventType: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export abstract class PushChannel {
  abstract send(message: PushMessage): Promise<void>;
  abstract describe(): string;
}
