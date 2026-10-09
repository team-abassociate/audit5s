import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  KAIZEN_STATUSES,
  type Kaizen,
  type KaizenAnalysis,
  type KaizenDashboard,
  type KaizenDashboardPeriod,
  type KaizenStatus,
  type Page,
} from '@audit5s/contracts';
import { formatDate, formatRupees, zoneDisplayLabel } from '@audit5s/domain';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Segmented,
  Select,
  Skeleton,
  Slip,
  StatusChip,
  Table,
  Td,
  Th,
  useRoutedPanel,
} from '@/components/ui';
import { api } from '@/lib/api';
import { KAIZEN_STATUS_LABEL } from '@/lib/labels';
import { useUnitScope } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { KaizenPanel } from './KaizenPanel';
import { FunnelCard, KpiCard, TopDepartmentsCard, TrendCard } from './visuals';

/**
 * Kaizen in the portal (plans/kaizen-module.md §4.4): Overview, the list with its detail
 * panel, and Analysis. Every read is scoped by the server; the portal's Unit picker only
 * narrows it (`unitId`), never widens it.
 */

/** `&unitId=…` when the portal is on one Unit, nothing for "All Units". */
function useUnitParam(): { ready: boolean; param: string } {
  const scope = useUnitScope();
  return { ready: scope.ready, param: scope.unitId ? `&unitId=${scope.unitId}` : '' };
}

// ------------------------------------------------------------------------------- list

export interface KaizensSearch {
  kaizen?: string;
  status?: Exclude<KaizenStatus, 'DRAFT'>;
}

export function validateKaizensSearch(search: Record<string, unknown>): KaizensSearch {
  const status = search.status;
  return {
    kaizen: typeof search.kaizen === 'string' && search.kaizen !== '' ? search.kaizen : undefined,
    status:
      typeof status === 'string' && status !== 'DRAFT' && KAIZEN_STATUSES.includes(status as KaizenStatus)
        ? (status as KaizensSearch['status'])
        : undefined,
  };
}

const PAGE = 100;

export function KaizensPage() {
  const search = useSearch({ strict: false }) as KaizensSearch;
  const navigate = useNavigate();
  const panel = useRoutedPanel('kaizen');
  const unit = useUnitParam();
  const status = search.status;

  const list = useInfiniteQuery({
    queryKey: ['kaizens', 'list', unit.param, status],
    queryFn: ({ pageParam }) =>
      api.get<Page<Kaizen>>(
        `/kaizens?limit=${PAGE}${unit.param}${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: unit.ready,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="gb-withpanel">
      <Card className="min-w-0">
        <CardHeader
          title="Kaizens"
          description="Every submitted Kaizen in your Units. Open one to read the sheet, review it, or download it as a PDF."
        />
        <div className="gb-filters">
          <Field label="Status">
            <Select
              value={status ?? ''}
              onChange={(event) =>
                void navigate({
                  to: '.',
                  search: ((prev: KaizensSearch) => ({ ...prev, status: (event.target.value || undefined) as KaizensSearch['status'] })) as never,
                  replace: true,
                  resetScroll: false,
                })
              }
            >
              <option value="">Any</option>
              {KAIZEN_STATUSES.filter((value) => value !== 'DRAFT').map((value) => (
                <option key={value} value={value}>
                  {KAIZEN_STATUS_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <KaizenRows query={list} rows={rows} openId={panel.id} onOpen={panel.open} empty={status ? 'No Kaizens with this status.' : 'No Kaizens submitted yet.'} />
        {list.hasNextPage && (
          <div className="p-4">
            <Button variant="secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Card>
      <KaizenPanel kaizenId={panel.id} onClose={panel.close} />
    </div>
  );
}

function KaizenRows({
  query,
  rows,
  openId,
  onOpen,
  empty,
}: {
  query: { isLoading: boolean; error: unknown; data?: unknown };
  rows: readonly Kaizen[];
  openId: string | null;
  onOpen: (id: string) => void;
  empty: string;
}) {
  if (query.isLoading) return <Skeleton variant="rows" columns={['Kaizen', 'Status', 'Author', 'Saving', 'Submitted']} />;
  if (query.error) {
    return (
      <div className="p-4">
        <ErrorNotice error={query.error} />
      </div>
    );
  }
  if (!query.data) return null;
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Kaizen</Th>
          <Th>Status</Th>
          <Th>Author · Zone</Th>
          <Th className="text-right">Annual saving</Th>
          <Th>Submitted</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((kaizen) => (
          <tr
            key={kaizen.id}
            className={openId === kaizen.id ? 'gb-row--open cursor-pointer' : 'cursor-pointer'}
            onClick={(event) => {
              if ((event.target as Element).closest('button, a')) return;
              onOpen(kaizen.id);
            }}
          >
            <Td>
              <button type="button" className="gb-rowtoggle" aria-current={openId === kaizen.id ? 'true' : undefined} onClick={() => onOpen(kaizen.id)}>
                {kaizen.theme ?? '—'}
              </button>
              <div className="gb-data text-xs text-ink-3">{kaizen.kaizenNo}</div>
            </Td>
            <Td>
              <StatusChip kind="kaizen" status={kaizen.status} />
            </Td>
            <Td>
              {kaizen.authorName}
              <div className="text-xs text-ink-3">{zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName)}</div>
            </Td>
            <Td className="gb-data text-right">{kaizen.annualSaving === null ? '—' : formatRupees(kaizen.annualSaving)}</Td>
            <Td className="gb-data">{kaizen.submittedAt ? formatDate(kaizen.submittedAt) : '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// --------------------------------------------------------------------------- overview

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The Kaizen overview: the KPI card first (§4.4), one slip only while a review waits, the
 * queue, then Top 3 approved by saving over the last 30 days. A row opens on the list.
 */
export function KaizenOverviewPage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const unit = useUnitParam();
  const [period, setPeriod] = useState<KaizenDashboardPeriod>('overall');
  const [since] = useState(() => new Date(Date.now() - THIRTY_DAYS_MS).toISOString());

  const dashboard = useQuery({
    queryKey: ['kaizen-dashboard', unit.param, period],
    queryFn: () => api.get<KaizenDashboard>(`/kaizens/dashboard?period=${period}${unit.param}`),
    enabled: unit.ready,
    placeholderData: keepPreviousData,
  });
  const queue = useQuery({
    queryKey: ['kaizens', 'queue', unit.param],
    queryFn: () => api.get<Page<Kaizen>>(`/kaizens?limit=50&status=SUBMITTED${unit.param}`),
    enabled: unit.ready,
  });
  const top = useQuery({
    queryKey: ['kaizens', 'top3', unit.param, since],
    queryFn: () =>
      api.get<Page<Kaizen>>(`/kaizens?limit=3&status=APPROVED&sort=saving&submittedFrom=${encodeURIComponent(since)}${unit.param}`),
    enabled: unit.ready,
  });
  const open = (id: string) => void navigate({ to: '/kaizen/list', search: { kaizen: id } as never });
  const waiting = queue.data?.data.length ?? 0;

  return (
    <div className="space-y-4">
      {dashboard.error ? <ErrorNotice error={dashboard.error} /> : null}
      {dashboard.data ? <KpiCard kpi={dashboard.data.kpi} period={period} onPeriod={setPeriod} /> : <Skeleton variant="tiles" count={6} label="Loading the Kaizen figures" />}
      {can('kaizen', 'review') && waiting > 0 ? (
        <Slip title={`${waiting} ${waiting === 1 ? 'Kaizen waits' : 'Kaizens wait'} for your review`}>
          <Link to="/kaizen/list" search={{ status: 'SUBMITTED' } as never} className="underline">
            Review them
          </Link>
        </Slip>
      ) : null}
      <Card>
        <CardHeader title="Awaiting review" />
        <KaizenRows query={queue} rows={queue.data?.data ?? []} openId={null} onOpen={open} empty="Nothing waiting for review." />
      </Card>
      <Card>
        <CardHeader title="Top 3 approved by saving" description="Approved Kaizens first submitted in the last 30 days, by annual saving." />
        <KaizenRows query={top} rows={top.data?.data ?? []} openId={null} onOpen={open} empty="No approved Kaizens in the last 30 days." />
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------- analysis

/**
 * Analysis (§4.4, §4.7): KPI card · funnel · trend on the first row, Top 5 Departments
 * below, then the department-wise / zone-wise table. One period drives the KPI card and the
 * funnel together; the trend is always the last six months.
 */
export function KaizenAnalysisPage() {
  const unit = useUnitParam();
  const [period, setPeriod] = useState<KaizenDashboardPeriod>('overall');
  const [by, setBy] = useState<'department' | 'zone'>('department');

  const dashboard = useQuery({
    queryKey: ['kaizen-dashboard', unit.param, period],
    queryFn: () => api.get<KaizenDashboard>(`/kaizens/dashboard?period=${period}${unit.param}`),
    enabled: unit.ready,
    placeholderData: keepPreviousData,
  });
  const analysis = useQuery({
    queryKey: ['kaizen-analysis', unit.param, by, period],
    queryFn: () => api.get<KaizenAnalysis>(`/kaizens/analysis?by=${by}&period=${period}${unit.param}`),
    enabled: unit.ready,
    placeholderData: keepPreviousData,
  });
  const data = dashboard.data;

  return (
    <div className="space-y-4">
      {dashboard.error ? <ErrorNotice error={dashboard.error} /> : null}
      {data ? (
        <div className="gb-kz-grid">
          <KpiCard kpi={data.kpi} period={period} onPeriod={setPeriod} />
          <FunnelCard funnel={data.funnel} period={period} onPeriod={setPeriod} />
          <TrendCard trend={data.trend} />
          <div className="gb-kz-wide">
            <TopDepartmentsCard months={data.trend.map((month) => month.month)} series={data.topDepartments} />
          </div>
        </div>
      ) : (
        <Skeleton variant="tiles" count={3} label="Loading the Kaizen dashboard" />
      )}

      <Card>
        <CardHeader
          title={by === 'zone' ? 'By Zone' : 'By department'}
          action={
            <Segmented
              label="Group by"
              options={[
                { value: 'department', label: 'Department' },
                { value: 'zone', label: 'Zone' },
              ]}
              value={by}
              onChange={setBy}
            />
          }
        />
        {analysis.error ? (
          <div className="p-4">
            <ErrorNotice error={analysis.error} />
          </div>
        ) : null}
        {analysis.data && analysis.data.rows.length === 0 ? <EmptyState title="No Kaizens submitted in this period." /> : null}
        {analysis.data && analysis.data.rows.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <Th>{by === 'zone' ? 'Zone' : 'Department'}</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Approved</Th>
                <Th className="text-right">Pending</Th>
                <Th className="text-right">Returned</Th>
                <Th className="text-right">Approved saving</Th>
              </tr>
            </thead>
            <tbody>
              {analysis.data.rows.map((row) => (
                <tr key={row.key}>
                  <Td>{row.zoneCode ? zoneDisplayLabel(row.zoneCode, row.label ?? '') : (row.label ?? 'No department')}</Td>
                  <Td className="gb-data text-right">{row.total}</Td>
                  <Td className="gb-data text-right">{row.approved}</Td>
                  <Td className="gb-data text-right">{row.pending}</Td>
                  <Td className="gb-data text-right">{row.returned}</Td>
                  <Td className="gb-data text-right">{formatRupees(row.approvedSaving)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
