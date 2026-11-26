import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TAKE_OVER_WITHOUT_SIGN_OUT_ROLES,
  type Audit,
  type AuditDetail,
  type Device,
  type Evidence,
  type EvidenceViewUrl,
  type Role,
} from '@audit5s/contracts';
import { api } from './api';
import { downloadPhoto } from './capture/media';
import { adoptServerAudit } from './db/adopt-audit.repository';
import type { LocalDatabase } from './db/local-database';
import { useLocalDatabase } from './db/provider';
import { getDeviceId } from './secure-storage';
import { useSession } from './session';

/**
 * R-92: an open audit belongs to the auditor's account, not to the phone it was started on.
 *
 * This is the phone's half. It asks the server for the auditor's IN_PROGRESS and PAUSED
 * audits that another device holds, and brings one here: the server moves the lock
 * (`POST /audits/{id}/take-over`), then the audit, its answers and its photographs are
 * written into SQLite and it resumes like any audit started on this phone.
 *
 * A Super Admin or Coordinator brings an audit across directly. A Consultant or Zone Leader
 * signs the other device out first (`POST /devices/{id}/revoke`), which the server checks.
 */

export interface AuditElsewhere {
  audit: Audit;
  /** The device holding it, when the server still lists it. Null for a free lock. */
  device: Device | null;
  /** Whether this person is still signed in on that device, so it must be signed out first. */
  stillSignedIn: boolean;
}

export const AUDITS_ELSEWHERE_KEY = ['remote', 'audits-elsewhere'] as const;

/** Whether this role continues an audit on another device without signing that device out. */
export function movesWithoutSignOut(role: Role | undefined): boolean {
  return role !== undefined && TAKE_OVER_WITHOUT_SIGN_OUT_ROLES.includes(role);
}

/**
 * The auditor's open audits held by a device other than this one.
 *
 * Online only, and quiet when offline: a phone in a dead zone simply shows its own audits,
 * as it always did.
 */
export function useAuditsElsewhere() {
  const { status, user } = useSession();
  return useQuery({
    queryKey: [...AUDITS_ELSEWHERE_KEY, user?.id],
    enabled: status === 'ready' && user !== null,
    queryFn: () => listAuditsElsewhere(user!.id),
    staleTime: 60_000,
    retry: false,
  });
}

export async function listAuditsElsewhere(userId: string): Promise<AuditElsewhere[]> {
  const here = await getDeviceId();
  const page = await api.getAll<Audit>(`/audits?auditorId=${userId}&active=true&limit=200`);
  const open = page.data.filter(
    (audit) =>
      audit.auditorUserId === userId &&
      (audit.status === 'IN_PROGRESS' || audit.status === 'PAUSED') &&
      audit.owningDeviceId !== here,
  );
  if (open.length === 0) return [];

  const devices = await api
    .getAll<Device>(`/devices?userId=${userId}&includeRevoked=true&limit=200`)
    .then((result) => result.data)
    .catch(() => [] as Device[]);
  const byId = new Map(devices.map((device) => [device.id, device]));

  return open.map((audit) => {
    const device = audit.owningDeviceId ? (byId.get(audit.owningDeviceId) ?? null) : null;
    const me = device?.people.find((person) => person.userId === userId);
    return {
      audit,
      device,
      stillSignedIn: device !== null && device.revokedAt === null && me !== undefined && me.revokedAt === null,
    };
  });
}

/** A device's name for a sentence: "Pixel 8", or a plain word when the OS gave none. */
export function deviceLabel(device: Device | null): string {
  if (!device) return 'another device';
  if (device.model) return device.model;
  return device.platform === 'web' ? 'a web browser' : 'another phone';
}

/**
 * Brings the given audits to this device.
 *
 * For a Consultant or Zone Leader, every device still holding one of them is signed out
 * first, from here. Then each audit is taken over and written into SQLite. Photographs are
 * downloaded one by one, and a photo that fails to download stays a placeholder rather than
 * stopping the audit from coming across.
 */
export function useContinueHere() {
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: async (items: readonly AuditElsewhere[]) => {
      if (!movesWithoutSignOut(user?.role)) {
        const toSignOut = new Set(
          items.filter((item) => item.stillSignedIn && item.device).map((item) => item.device!.id),
        );
        for (const deviceId of toSignOut) {
          await api.post<Device>(`/devices/${deviceId}/revoke`);
        }
      }
      const deviceId = await getDeviceId();
      for (const item of items) {
        await bringAuditHere(database, item.audit.id, deviceId);
      }
      return items.map((item) => item.audit.id);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: AUDITS_ELSEWHERE_KEY });
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });
}

export async function bringAuditHere(database: LocalDatabase, auditId: string, deviceId: string): Promise<void> {
  const detail = await api.post<AuditDetail>(`/audits/${auditId}/take-over`, { deviceId });
  const evidence = (await api.getAll<Evidence>(`/audits/${auditId}/evidence?limit=200`)).data;

  const files = new Map<string, string>();
  for (const photo of evidence) {
    if (photo.deletedAt || photo.correctiveActionId) continue;
    try {
      const link = await api.get<EvidenceViewUrl>(`/evidence/${photo.id}/view-url`);
      files.set(photo.id, await downloadPhoto(link.url, photo.id));
    } catch {
      // Shown as a placeholder; the audit still comes across.
    }
  }

  await adoptServerAudit(database, detail, evidence, files);
}
