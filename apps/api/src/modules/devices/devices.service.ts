import { Injectable } from '@nestjs/common';
import type { Device, ListDevicesQuery, Page, RegisterDeviceRequest } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { DevicesRepository, type DeviceRow } from './devices.repository';

/**
 * Devices (§8.11, PART 6's `device:list` / `device:revoke`).
 *
 * §8.11 gives `POST /devices/register` to "any" role, and that is honoured literally: a
 * device registers itself under whoever is signed in, and nobody registers a device for
 * somebody else. There is no `userId` in the request shape, so the question cannot arise.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly repository: DevicesRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async register(scope: ScopeContext, request: RegisterDeviceRequest): Promise<Device> {
    const existing = await this.repository.findById(scope, request.deviceId);
    if (existing?.revokedAt) {
      throw AppError.forbidden(
        'DEVICE_REVOKED',
        'This device was revoked. An administrator must clear it before it can be used again.',
      );
    }

    await this.repository.register(scope, {
      id: request.deviceId,
      platform: request.platform,
      model: request.model ?? null,
      osVersion: request.osVersion ?? null,
      appVersion: request.appVersion ?? null,
      pushToken: request.pushToken ?? null,
    });

    // A phone this person is not on reads as **absent**, not as a conflict. That is AZ-3:
    // "out-of-scope reads return 404, not 403, so object IDs cannot be probed for
    // existence." Joining a shared phone is done by signing in on it (0025) — proving the
    // credentials on that hardware — not by naming its id here, so the upsert wrote
    // nothing and this read is what makes the refusal explicit rather than a silent no-op.
    return this.get(scope, request.deviceId);
  }

  async list(scope: ScopeContext, query: ListDevicesQuery): Promise<Page<Device>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toDevice), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, deviceId: string): Promise<Device> {
    const device = await this.repository.findById(scope, deviceId);
    if (!device) {
      throw AppError.notFound('No such device');
    }
    return toDevice(device);
  }

  /**
   * Revokes a device and its sessions.
   *
   * It does **not** touch the audits that device owns. A lost phone that holds a D7 lock
   * is released through `POST /audits/{id}/release-device`, separately and audit-logged,
   * because releasing a lock is a decision about an audit and revoking a device is a
   * decision about a credential — and conflating them would mean a routine revocation
   * silently handed an in-progress audit to whoever asked for it next.
   */
  async revoke(scope: ScopeContext, deviceId: string): Promise<Device> {
    const device = await this.repository.findById(scope, deviceId);
    if (!device) {
      throw AppError.notFound('No such device');
    }
    if (device.revokedAt) {
      return toDevice(device);
    }

    // A phone is shared (0025). A Super Admin revoking it — a lost or stolen handset —
    // stops it for everybody; a field user revoking "their" device is taking themselves
    // off it, and must not sign their colleagues out of the phone they are holding.
    const wholePhone = scope.actor.role === 'SUPER_ADMIN';
    if (wholePhone) {
      await this.repository.revoke(scope, deviceId);
    } else {
      await this.repository.leave(scope, deviceId, scope.actor.userId);
    }

    await this.auditLog.record({
      action: 'device.revoked',
      resourceType: 'device',
      resourceId: deviceId,
      before: { revokedAt: null },
      after: wholePhone
        ? { revokedAt: new Date().toISOString(), people: device.people.map((p) => p.userId) }
        : { revokedAt: new Date().toISOString(), userId: scope.actor.userId },
    });

    return this.get(scope, deviceId);
  }

  async touchSync(scope: ScopeContext, deviceId: string): Promise<void> {
    await this.repository.touchSync(scope, deviceId);
  }
}

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userId: row.userId,
    people: row.people.map((person) => ({
      userId: person.userId,
      fullName: person.fullName,
      lastSignedInAt: person.lastSignedInAt.toISOString(),
      revokedAt: person.revokedAt?.toISOString() ?? null,
    })),
    platform: row.platform as Device['platform'],
    model: row.model,
    osVersion: row.osVersion,
    appVersion: row.appVersion,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
