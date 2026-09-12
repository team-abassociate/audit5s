import type { ScopeContext } from '@audit5s/domain';

/**
 * The scope a scheduled job acts under (R-15c).
 *
 * There is no system bypass in this schema, by design: `setActorContext` is how every
 * repository tells RLS who is asking, and a worker has no request and therefore no actor.
 * So it borrows the narrowest thing that works — an organisation-scoped Super Admin — and
 * that is a deliberate choice with two halves:
 *
 *   - `resolver: 'organization'` is what lets a nightly job read across Units at all. A
 *     rollup or a sweep that could only see one actor's Units would produce partial output
 *     and no error.
 *   - It widens *who* may read. It never widens *what* a query asks for: every job read
 *     still carries its own `unitId` predicate, because the job is scheduled per Unit and
 *     a finding belongs to one.
 *
 * The id is a fixed nil-ish UUIDv4 rather than a real account: no person is credited with
 * what a timer did, and an audit-log row naming this id is unambiguously the system.
 *
 * One definition, because two would drift and the second one to drift would be the one
 * that reads more than it should.
 */
export const SYSTEM_SCOPE: ScopeContext = {
  actor: {
    userId: '00000000-0000-4000-8000-000000000000',
    role: 'SUPER_ADMIN',
    activeUnitId: null,
    unitIds: [],
    deviceId: null,
  },
  resolver: 'organization',
};
