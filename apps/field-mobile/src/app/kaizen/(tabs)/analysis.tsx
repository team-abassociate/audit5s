import { useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { KaizenAnalysis, KaizenDashboard, KaizenDashboardPeriod } from '@audit5s/contracts';
import { AnalysisTable, FunnelCard, KpiCard, TopDepartmentsCard, TrendCard } from '../../../components/kaizen-charts';
import { ErrorBanner, Screen } from '../../../components/ui';
import { api } from '../../../lib/api';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { createThemedStyles } from '../../../lib/theme';

/**
 * Kaizen Analysis (§4.3, §4.7), top to bottom: the KPI card, the funnel, the six-month
 * trend, the top-5 departments, then the department-wise / zone-wise table. One period
 * control drives the KPI card and the funnel together (the trend is always six months).
 */
export default function KaizenAnalysisScreen() {
  const styles = useStyles();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [period, setPeriod] = useState<KaizenDashboardPeriod>('overall');
  const [by, setBy] = useState<'department' | 'zone'>('department');

  const dashboard = useQuery({
    queryKey: ['kaizen-dashboard', period],
    queryFn: () => api.get<KaizenDashboard>(`/kaizens/dashboard?period=${period}`),
    placeholderData: (previous) => previous,
  });
  const analysis = useQuery({
    queryKey: ['kaizen-analysis', by, period],
    queryFn: () => api.get<KaizenAnalysis>(`/kaizens/analysis?by=${by}&period=${period}`),
    placeholderData: (previous) => previous,
  });
  const data = dashboard.data;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={dashboard.isRefetching || analysis.isRefetching}
            onRefresh={() => {
              void dashboard.refetch();
              void analysis.refetch();
            }}
          />
        }
      >
        <ErrorBanner message={dashboard.isError || analysis.isError ? t.needsConnection : null} />
        {data ? (
          <>
            <KpiCard kpi={data.kpi} period={period} onPeriod={setPeriod} />
            <FunnelCard funnel={data.funnel} period={period} onPeriod={setPeriod} />
            <TrendCard trend={data.trend} />
            <TopDepartmentsCard months={data.trend.map((month) => month.month)} series={data.topDepartments} />
          </>
        ) : null}
        {analysis.data ? <AnalysisTable rows={analysis.data.rows} by={by} onBy={setBy} /> : null}
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.lg, paddingBottom: theme.space.xl * 2, gap: theme.space.sm },
}));
