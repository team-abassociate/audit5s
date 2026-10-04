// The `?data=worst` dataset (dev only, loaded by worst-case.ts): long and Devanagari names,
// counts of 0, 1 and many, 200-row lists (one page, the most these screens ask for).
import type { AuditAssignment, MembershipDetail, Page, Role, Unit, User, Zone } from '@audit5s/contracts';

const AT = '2026-09-30T08:35:00.000Z';
const id = (kind: number, n: number) => `00000000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
const page = <T>(data: T[]): Page<T> => ({ data, nextCursor: null });

const UNIT_NAMES = [
  'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd',
  'A1',
  'श्री गणेश ऑटो पार्ट्स, चाकण',
];
// 200 Units: the list asks for one page of 200 and is not paged further.
const units: Unit[] = Array.from({ length: 200 }, (_, n) => ({
  id: id(1, n),
  name: UNIT_NAMES[n] ?? `Nashik Plant ${n + 1}`,
  address: n === 0 ? 'Plot No. B-24/7, MIDC Ambad Industrial Area, Behind Mahindra Gate No. 3' : null,
  city: n === 0 ? 'Pimpri-Chinchwad (Pune Metropolitan Region)' : n === 1 ? null : 'Nashik',
  state: 'Maharashtra',
  country: 'India',
  postalCode: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  latitude: null,
  longitude: null,
  geofenceRadiusM: null,
  timezone: n === 2 ? 'Asia/Dubai' : 'Asia/Kolkata',
  industryId: null,
  industryName: null,
  photoCapPerZone: 3,
  version: 1,
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
}));

const LEADER = 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
const ZONE_NAMES = ['पेंट शॉप (रंगाई विभाग)', 'Stores', 'Heat Treatment, Shot Blasting & Final Inspection Bay', 'Q'];
// Unit 1 has 1 Zone, unit 2 none, unit 0 the rest (199): the counts 0, 1 and many.
const zones: Zone[] = Array.from({ length: 200 }, (_, n) => ({
  id: id(2, n),
  unitId: units[n === 0 ? 1 : 0]!.id,
  code: String(n + 1),
  name: ZONE_NAMES[n % 4]!,
  description:
    n % 3 === 0
      ? 'Covers the press line, the coil yard behind it, and the scrap bins next to the east loading dock'
      : null,
  departmentHint: null,
  defaultChecklistTemplateId: null,
  zoneLeaderId: null,
  zoneLeaderName: n % 2 === 0 ? LEADER : n % 5 === 0 ? 'Jo' : null,
  sortOrder: n,
  version: 1,
  archivedAt: n % 7 === 6 ? AT : null,
  createdAt: AT,
  updatedAt: AT,
}));

const PEOPLE = [
  LEADER,
  'Jo',
  'Aleksandra Wiśniewska-Kowalczyk',
  'राजेश कुमार शर्मा',
  'Bartholomew Fitzgerald-Montgomery III',
];
const ROLES: Role[] = ['ZONE_LEADER', 'CONSULTANT', 'COORDINATOR', 'SUPER_ADMIN'];
const users: User[] = Array.from({ length: 200 }, (_, n) => ({
  id: id(3, n),
  loginId: `UX${String(1000 + n)}`,
  fullName: PEOPLE[n % PEOPLE.length]!,
  phoneE164: `+9198765${String(10000 + n).slice(-5)}`,
  email: n % 4 === 0 ? 'bartholomew.fitzgerald@northwind-industries-holdings.example.com' : null,
  role: ROLES[n % 4]!,
  status: n % 9 === 4 ? 'DISABLED' : 'ACTIVE',
  mustResetPassword: n % 3 === 0,
  bootstrapExpiresAt: null,
  lastLoginAt: n % 2 ? AT : null,
  createdByUserId: null,
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
}));

// Coordinator 2 runs units 0 and 1, so unit 1 lists two names; the Zone Leaders belong to
// the long-named Unit; Consultant 1 reaches 25 Units through assignments.
const memberships: MembershipDetail[] = [
  ...[0, 1].map((u) => [users[2]!, units[u]!] as const),
  [users[6]!, units[1]!] as const,
  ...users.filter((user) => user.role === 'ZONE_LEADER').map((user) => [user, units[0]!] as const),
].map(([user, unit], n) => ({
  id: id(4, n),
  userId: user.id,
  unitId: unit.id,
  role: user.role,
  status: 'ACTIVE',
  validFrom: AT,
  validTo: null,
  assignedByUserId: users[3]!.id,
  createdAt: AT,
  updatedAt: AT,
  userFullName: user.fullName,
  userLoginId: user.loginId,
  unitName: unit.name,
}));

const assignments: AuditAssignment[] = units.slice(0, 25).map((unit, n) => ({
  id: id(5, n),
  unitId: unit.id,
  unitName: unit.name,
  auditorUserId: users[1]!.id,
  auditorName: users[1]!.fullName,
  auditType: 'EXTERNAL_5S',
  status: 'ASSIGNED',
  dueAt: null,
  instructions: null,
  suggestedZoneIds: [],
  groupId: null,
  createdByUserId: users[3]!.id,
  cancelledAt: null,
  cancelReason: null,
  createdAt: AT,
  updatedAt: AT,
}));

export function fixture(path: string): unknown {
  const [route = '', search = ''] = path.split('?');
  const q = new URLSearchParams(search);
  const unitZones = route.match(/^\/units\/([^/]+)\/zones$/);
  if (unitZones) return page(zones.filter((zone) => zone.unitId === unitZones[1]));
  const unit = route.match(/^\/units\/([^/]+)$/);
  if (unit) return units.find((candidate) => candidate.id === unit[1]);
  if (route === '/units') return page(units);
  if (route === '/zones') return page(zones.filter((zone) => !zone.archivedAt));
  if (route === '/users' && !q.has('role')) return page(users);
  if (route === '/memberships' && !q.has('userId')) {
    return page(
      memberships.filter(
        (m) => (!q.get('role') || m.role === q.get('role')) && (!q.get('unitId') || m.unitId === q.get('unitId')),
      ),
    );
  }
  if (route === '/audit-assignments' && !q.has('auditorUserId')) return page(assignments);
  return undefined;
}
