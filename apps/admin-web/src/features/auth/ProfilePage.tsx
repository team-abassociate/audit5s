import { useQuery } from '@tanstack/react-query';
import type { ConsultantActivity, Page, Unit } from '@audit5s/contracts';
import { formatDateTime } from '@audit5s/domain';
import { useDocumentTitle } from '@/components/AppShell';
import { Card, CardHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { roleLabel } from '@/lib/labels';
import { useSession } from '@/lib/session';

/**
 * The phone's Profile on the web: who you are, your account, and a Consultant's own
 * activity. The theme, sign-out and the 5S | Kaizen switch are already in the shell, so
 * they are not repeated here; the phone's catalogue sync has no web counterpart, because
 * the web reads the server live.
 */
export function ProfilePage() {
  const { user, scope } = useSession();
  useDocumentTitle('Profile');
  const units = useQuery({
    queryKey: ['units', 'profile'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
    enabled: Boolean(scope && !scope.organizationWide),
  });
  const activity = useQuery({
    queryKey: ['analytics', 'activity', 'me'],
    queryFn: () => api.get<ConsultantActivity | null>('/analytics/activity/me'),
    enabled: user?.role === 'CONSULTANT',
  });
  if (!user) return null;

  const rows: [string, string][] = [
    ['Name', user.fullName],
    ['Login ID', user.loginId],
    ['Role', roleLabel(user.role)],
    ['Phone', user.phoneE164],
    ['Email', user.email ?? '—'],
    ['Units', scope?.organizationWide ? 'All Units' : (units.data?.data.map((unit) => unit.name).join(', ') ?? '…')],
    ['Last sign-in', user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'],
  ];
  const a = activity.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Account" />
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-4 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd className="text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {user.role === 'CONSULTANT' ? (
        <Card>
          <CardHeader title="My activity" description="Completed audits, Zones covered and photographs captured." />
          {a ? (
            <div className="gb-kpis p-4">
              {[
                ['Audits', String(a.auditsCompleted)],
                ['Zones', String(a.zonesCovered)],
                ['Photos', String(a.photosCaptured)],
                ['Average duration', a.averageDurationMinutes === null ? '—' : `${a.averageDurationMinutes.toFixed(0)} min`],
                ['Last active', a.lastActiveAt ? formatDateTime(a.lastActiveAt) : '—'],
              ].map(([label, value]) => (
                <div key={label} className="gb-tile gb-kpi">
                  <span className="gb-label">{label}</span>
                  <b className="gb-figure">{value}</b>
                </div>
              ))}
            </div>
          ) : (
            <p className="p-4 text-sm text-ink-2">{activity.isLoading ? 'Loading…' : 'No completed audits yet.'}</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}
