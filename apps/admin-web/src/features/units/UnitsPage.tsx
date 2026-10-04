import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { MembershipDetail, Page, Unit, Zone } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { devGet } from '@/features/units/worst-case';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Skeleton,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { NewUnitDialog } from '@/features/units/NewUnitDialog';
import { useSession } from '@/lib/session';
import { UnitZones } from '@/features/zones/UnitZones';
import { rowToggleProps } from '@/features/audits/AuditsPage';

export function UnitsPage() {
  const { can } = useSession();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => devGet<Page<Unit>>('/units?limit=200'),
  });
  // Who runs each plant (U7). A Consultant holds no membership (R-28), so this names the
  // Coordinators only; the Unit's own page lists everyone.
  const coordinators = useQuery({
    queryKey: ['memberships', 'role', 'COORDINATOR'],
    queryFn: () =>
      devGet<Page<MembershipDetail>>('/memberships?role=COORDINATOR&status=ACTIVE&limit=200'),
    enabled: can('unit_membership', 'read'),
  });
  // ponytail: one page of 200 active Zones across every Unit, like every list here; server
  // paging (S15e) lifts it.
  const zones = useQuery({
    queryKey: ['zones', 'all'],
    queryFn: () => devGet<Page<Zone>>('/zones?limit=200'),
    enabled: can('zone', 'read'),
  });

  const query = search.trim().toLocaleLowerCase();
  const list = (units.data?.data ?? []).filter((unit) =>
    [unit.name, unit.city, unit.state].some((value) => value?.toLocaleLowerCase().includes(query)),
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Units & zones"
          description="Every Unit you may see. Open a Unit's name for its Zones."
          action={can('unit', 'create') ? <Button onClick={() => setCreating(true)}>New Unit</Button> : null}
        />

        {can('unit', 'create') && (
          <NewUnitDialog
            open={creating}
            onClose={(unitId) => {
              setCreating(false);
              // A Unit made here opens on its row, its new Zones in view (report §5 Task 1, step 4).
              if (unitId) setExpanded(unitId);
            }}
          />
        )}

        <div className="border-b border-edge-soft bg-board p-4">
          <Field label="Search units">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, city or state…"
            />
          </Field>
        </div>

        {units.isLoading && (
          <Skeleton variant="rows" columns={['Unit', 'City', 'Coordinator', 'Zones', '']} rows={4} label="Loading Units…" />
        )}
        {units.error && <div className="p-4"><ErrorNotice error={units.error} /></div>}

        {units.data && list.length === 0 && (
          <EmptyState title={query ? 'No matching Units.' : 'No Units yet.'}>
            {query ? 'Try another name or city.' : can('unit', 'create') ? 'Add the first with New Unit.' : null}
          </EmptyState>
        )}

        {units.data && list.length > 0 && (
          <Table variant="register" label="Units">
            <thead>
              <tr>
                <Th width="34%">Unit</Th>
                <Th width="18%">City</Th>
                <Th width="24%">Coordinator</Th>
                <Th width="9%">Zones</Th>
                <Th width="15%"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {list.map((unit) => (
                <UnitRow
                  key={unit.id}
                  unit={unit}
                  coordinators={(coordinators.data?.data ?? [])
                    .filter((m) => m.unitId === unit.id)
                    .map((m) => m.userFullName)}
                  zoneCount={zones.data ? zones.data.data.filter((z) => z.unitId === unit.id).length : null}
                  expanded={expanded === unit.id}
                  onToggle={() => setExpanded(expanded === unit.id ? null : unit.id)}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UnitRow({
  unit,
  coordinators,
  zoneCount,
  expanded,
  onToggle,
}: {
  unit: Unit;
  coordinators: string[];
  zoneCount: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () => api.post<void>(`/units/${unit.id}/archive`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['units'] }),
  });

  return (
    <Fragment>
      <tr {...rowToggleProps(onToggle)}>
        <Td>
          <button
            type="button"
            className="flex items-center gap-2 text-left font-medium"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <span className="text-ink-3" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="min-w-0 break-words">{unit.name}</span>
          </button>
        </Td>
        <Td>{unit.city ?? '—'}</Td>
        <Td>{coordinators.length ? coordinators.join(', ') : <span className="text-ink-3">None</span>}</Td>
        <Td className="gb-data">{zoneCount ?? '—'}</Td>
        <Td>
          <RowActions
            subject={unit.name}
            primary={
              can('unit', 'update_profile') ? (
                <Link to="/units/$unitId" params={{ unitId: unit.id }} className="gb-btn">
                  Edit
                </Link>
              ) : null
            }
            items={
              can('unit', 'archive')
                ? [
                    {
                      label: 'Archive',
                      danger: true,
                      confirm: {
                        title: `Archive ${unit.name}?`,
                        body: 'It leaves the Units list and every picker. Its audits, reports and history stay on record. The portal has no way to bring it back.',
                        confirmLabel: 'Archive',
                        pendingLabel: 'Archiving…',
                        run: () => archive.mutateAsync(),
                      },
                    },
                  ]
                : []
            }
          />
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="p-0">
            <UnitZones unitId={unit.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
