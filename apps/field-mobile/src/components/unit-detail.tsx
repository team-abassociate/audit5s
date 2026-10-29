import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { File } from 'expo-file-system';
import {
  ZONE_LIST_IMPORT_MAX_BYTES,
  type Audit,
  type MembershipDetail,
  type Page,
  type Unit,
  type User,
  type Zone,
  type AuditorListImportResult,
  type ZoneListImportResult,
} from '@audit5s/contracts';
import { auditDays, formatDate, zoneDisplayLabel, zonesLine } from '@audit5s/domain';
import { UnitForm } from './unit-form';
import { ZoneForm } from './zone-form';
import {
  Button,
  Card,
  CardHeader,
  ChoiceList,
  ConfirmAction,
  Data,
  EmptyState,
  ErrorBanner,
  HeaderAction,
  LedgerRow,
  Muted,
} from './ui';
import { api, ApiError, problemMessage } from '../lib/api';
import { ROLE_LABELS } from '../lib/labels';
import { useSession } from '../lib/session';
import { createThemedStyles, useTheme } from '../lib/theme';
import { leaveScreen } from '../lib/leave-screen';

/**
 * One Unit: its details, its Zones, the people with access, and the way to start an audit
 * there. Archiving is the "delete": nothing in the audit trail is ever removed (D8), so the
 * Unit leaves every list and keeps its history.
 *
 * Rendered by a Super Admin's `manage/unit/[unitId]` route and by a Coordinator's My Unit tab
 * (R-42), which is this page with the tab bar still under it. Every control is gated on
 * `can()`, so the same component serves both roles:
 *
 * - **Details:** both edit them; only a Super Admin renames (U-1).
 * - **Zones:** both add, edit, lead and archive them (§6.3 `zone:*`).
 * - **People:** a Super Admin grants and revokes access; a Coordinator adds Zone leaders
 *   (R-39), and opens a person to edit, reset or disable them.
 */
export function UnitDetail({ unitId, addZone }: { unitId: string; addZone?: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  // The Zone open for editing, or 'new' for the add form. One at a time: a phone shows one form.
  const [zoneOpen, setZoneOpen] = useState<string | null>(addZone ? 'new' : null);
  // Asked for from elsewhere (Overview's "Add a Zone") while this page is already mounted.
  useEffect(() => {
    if (addZone) setZoneOpen('new');
  }, [addZone]);

  const mayEdit = can('unit', 'update_profile');
  const mayGrant = can('unit_membership', 'create');
  const mayRevoke = can('unit_membership', 'revoke');
  const mayAddZone = can('zone', 'create');
  const mayEditZone = can('zone', 'update');
  // A Coordinator creates Zone leaders and nobody else (§6.3); a Super Admin has the People tab.
  const mayAddLeader = can('user', 'create') && !mayGrant;

  const unit = useQuery({ queryKey: ['unit', unitId], queryFn: () => api.get<Unit>(`/units/${unitId}`) });
  // This Unit's Zones. `/zones` takes no Unit filter and listed every Unit's.
  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?limit=200`),
  });
  const members = useQuery({
    queryKey: ['memberships', 'unit', unitId],
    queryFn: () => api.get<Page<MembershipDetail>>(`/memberships?limit=200&unitId=${unitId}&status=ACTIVE`),
  });
  const people = useQuery({
    queryKey: ['users', 'all-active'],
    queryFn: () => api.get<Page<User>>('/users?limit=200&status=ACTIVE'),
    enabled: adding,
  });

  // Coming back from adding a Zone leader or disabling someone: the lists must say so.
  const { refetch: refetchZones } = zones;
  const { refetch: refetchMembers } = members;
  useFocusEffect(
    useCallback(() => {
      void refetchZones();
      void refetchMembers();
    }, [refetchZones, refetchMembers]),
  );

  // Back closes an open form and stays on this page: the forms open in place, so without this
  // Android's back leaves the page (from the My Unit tab, all the way to Overview). Only while
  // focused, so back on a person's page pushed over this one still pops that page.
  const formOpen = editing || adding || zoneOpen !== null;
  useFocusEffect(
    useCallback(() => {
      if (!formOpen) return;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        setEditing(false);
        setAdding(false);
        setZoneOpen(null);
        return true;
      });
      return () => subscription.remove();
    }, [formOpen]),
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      queryClient.invalidateQueries({ queryKey: ['users'] }),
    ]);
  const grant = useMutation({
    mutationFn: (userId: string) => api.post(`/units/${unitId}/memberships`, { userId }),
    onSuccess: async () => {
      setAdding(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (membership: MembershipDetail) => api.delete(`/units/${unitId}/memberships/${membership.id}`),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () => api.post(`/units/${unitId}/archive`),
    onSuccess: () => {
      leaveScreen(
        () => router.back(),
        () => void queryClient.invalidateQueries({ queryKey: ['units'] }),
      );
    },
  });

  if (unit.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </View>
    );
  }
  if (!unit.data) {
    return <EmptyState title="Unit not available" detail={problemMessage(unit.error) ?? 'It may have been archived.'} />;
  }

  const u = unit.data;
  const zoneList = [...(zones.data?.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const memberIds = new Set((members.data?.data ?? []).map((member) => member.userId));
  const addable = (people.data?.data ?? []).filter(
    (person) => person.role !== 'SUPER_ADMIN' && !memberIds.has(person.id),
  );
  const openPerson = (userId: string) => router.push({ pathname: '/manage/person/[userId]', params: { userId } });

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={unit.isRefetching}
          onRefresh={() => void Promise.all([unit.refetch(), zones.refetch(), members.refetch()])}
        />
      }
    >
      {can('audit', 'read') ? <UnitAuditDays unitId={unitId} /> : null}

      {editing ? (
        <UnitForm
          unit={u}
          canRename={can('unit', 'update_identity')}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Card>
          <CardHeader
            title="Details"
            action={
              mayEdit ? (
                <HeaderAction icon="edit" title="Edit" accessibilityLabel="Edit the Unit's details" onPress={() => setEditing(true)} />
              ) : null
            }
          />
          <LedgerRow label="Address" value={u.address ?? '—'} />
          <LedgerRow label="City" value={[u.city, u.state, u.postalCode].filter(Boolean).join(', ') || '—'} />
          <LedgerRow label="Contact" value={u.contactName ?? '—'} />
          <LedgerRow label="Phone" value={u.contactPhone ?? '—'} />
          <LedgerRow label="Email" value={u.contactEmail ?? '—'} last />
        </Card>
      )}

      <Card>
        <CardHeader
          title="Zones"
          description={
            zones.data
              ? `${zoneList.length} active.${mayEditZone ? ' Tap a Zone to edit or archive it.' : ''}`
              : null
          }
          action={
            mayAddZone && zoneOpen !== 'new' ? (
              <HeaderAction icon="add" title="Zone" accessibilityLabel="Add a Zone" onPress={() => setZoneOpen('new')} />
            ) : null
          }
        />
        {mayAddZone && zoneOpen === null ? (
          <ImportList kind="zones" unitId={unitId} importedAt={unit.data?.zoneListImportedAt ?? null} />
        ) : null}
        {can('user', 'create') && zoneOpen === null ? <ImportList kind="auditors" unitId={unitId} importedAt={null} /> : null}
        {zoneOpen === 'new' ? (
          <ZoneForm unitId={unitId} existing={zoneList} onDone={() => setZoneOpen(null)} />
        ) : null}
        {zoneList.map((zone, index) =>
          zoneOpen === zone.id ? (
            <View key={zone.id} style={styles.item}>
              {/* The open Zone's head folds it away again, without saving — Cancel's job, in reach. */}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: true }}
                accessibilityLabel={`Collapse ${zoneDisplayLabel(zone.code, zone.name)}`}
                onPress={() => setZoneOpen(null)}
                hitSlop={6}
                style={({ pressed }) => [styles.rowHead, pressed && styles.itemPressed]}
              >
                <Text style={[styles.itemTitle, styles.rowText]}>{zoneDisplayLabel(zone.code, zone.name)}</Text>
                <Text style={styles.chevron}>▴</Text>
              </Pressable>
              <ZoneForm unitId={unitId} zone={zone} existing={zoneList} onDone={() => setZoneOpen(null)} />
            </View>
          ) : (
            <Pressable
              key={zone.id}
              disabled={!mayEditZone}
              accessibilityRole={mayEditZone ? 'button' : undefined}
              accessibilityLabel={mayEditZone ? `Edit ${zoneDisplayLabel(zone.code, zone.name)}` : undefined}
              onPress={() => setZoneOpen(zone.id)}
              style={({ pressed }) => [
                styles.item,
                index === zoneList.length - 1 && styles.itemLast,
                pressed && styles.itemPressed,
              ]}
            >
              <View style={styles.rowHead}>
                <View style={styles.rowText}>
                  <Text style={styles.itemTitle}>{zoneDisplayLabel(zone.code, zone.name)}</Text>
                  <Data>{zone.zoneLeaderName ? `Leader ${zone.zoneLeaderName}` : 'No Zone leader'}</Data>
                </View>
                {mayEditZone ? <Text style={styles.chevron}>›</Text> : null}
              </View>
            </Pressable>
          ),
        )}
        {zones.data && zoneList.length === 0 && zoneOpen !== 'new' ? (
          <Muted>{mayAddZone ? 'No Zones yet. Import the Zone list, or add one with + Zone.' : 'No Zones yet.'}</Muted>
        ) : null}
        <ErrorBanner message={zones.error ? problemMessage(zones.error) : null} />
      </Card>

      <Card>
        <CardHeader
          title="People"
          description={
            mayRevoke
              ? 'Who can reach this Unit. Revoking access removes it from their phone on its next sync.'
              : mayAddLeader
                ? 'Who can reach this Unit. Open a Zone leader to edit, reset or disable them.'
                : 'Who can reach this Unit. Access is given and removed by a Super Admin.'
          }
          action={
            mayAddLeader ? (
              <HeaderAction icon="person-add"
                title="Zone leader"
                accessibilityLabel="Add a Zone leader"
                onPress={() =>
                  router.push({ pathname: '/manage/new-person', params: { role: 'ZONE_LEADER', unitId } })
                }
              />
            ) : null
          }
        />
        {(members.data?.data ?? []).map((member, index, all) => (
          <Pressable
            key={member.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${member.userFullName}`}
            onPress={() => openPerson(member.userId)}
            style={({ pressed }) => [
              styles.item,
              index === all.length - 1 && !mayGrant && styles.itemLast,
              pressed && styles.itemPressed,
            ]}
          >
            <View style={styles.rowHead}>
              <View style={styles.rowText}>
                <Text style={styles.itemTitle}>{member.userFullName}</Text>
                <Data>
                  {ROLE_LABELS[member.role]}, {member.userLoginId ?? 'no mobile number yet'}
                </Data>
              </View>
              {mayRevoke ? (
                <ConfirmAction
                  compact
                  title="Revoke"
                  question={`Revoke ${member.userFullName}'s access to ${u.name}? Their past audits stay.`}
                  confirmLabel="Revoke"
                  busy={revoke.isPending && revoke.variables?.id === member.id}
                  onConfirm={() => revoke.mutate(member)}
                />
              ) : (
                <Text style={styles.chevron}>›</Text>
              )}
            </View>
          </Pressable>
        ))}
        {members.data && members.data.data.length === 0 ? <Muted>Nobody has access yet.</Muted> : null}
        <ErrorBanner message={problemMessage(revoke.error ?? grant.error)} />
        {!mayGrant ? null : adding ? (
          <View style={styles.adding}>
            <ChoiceList
              value={null}
              onChange={(userId) => grant.mutate(userId)}
              empty={people.isLoading ? 'Loading people…' : 'Everyone active already has access.'}
              options={addable.map((person) => ({
                value: person.id,
                label: person.fullName,
                detail: `${ROLE_LABELS[person.role]}, ${person.loginId}`,
              }))}
            />
            <Button icon="close" title="Cancel" variant="secondary" onPress={() => setAdding(false)} />
          </View>
        ) : (
          <Button icon="vpn-key" title="Give someone access" variant="secondary" onPress={() => setAdding(true)} />
        )}
      </Card>

      <View style={styles.actions}>
        {can('audit', 'create_external') ? (
          <Button icon="play-arrow"
            title="Start an audit here"
            onPress={() => router.push({ pathname: '/unit/[unitId]', params: { unitId } })}
          />
        ) : null}
        {can('unit', 'archive') ? (
          <ConfirmAction
            title="Archive Unit"
            question={`Archive ${u.name}? It leaves every list and no new audit can start there. Its Coordinator and Zone Leaders lose access to 5S and Kaizen and are signed out. Its audits, reports and people's history are kept.`}
            confirmLabel="Archive"
            busy={archive.isPending}
            onConfirm={() => archive.mutate()}
          />
        ) : null}
        <ErrorBanner message={problemMessage(archive.error)} />
      </View>
    </ScrollView>
  );
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Each list's file, endpoint and template, as the web serves them. */
const LISTS = {
  zones: { title: 'Zone list', path: 'zones', template: 'zone-list-template.xlsx', mimeTypes: ['application/pdf', XLSX] },
  auditors: { title: 'Auditor list', path: 'auditors', template: 'auditor-list-template.xlsx', mimeTypes: [XLSX] },
} as const;

/**
 * R-59: the Unit's Zone list from an Excel or PDF file — Zone No., Zone Name (or
 * Description) and Leader; a Zone's several leaders are all its names (R-64). A second
 * import replaces the first, archiving the Zones it leaves out, so it asks first.
 *
 * R-64: the Auditor list from Excel — Zone No., ZL, Name and Mobile No. Each person the
 * Unit has no account for becomes a Zone Leader with no Zone. It only adds people.
 */
function ImportList({ kind, unitId, importedAt }: { kind: keyof typeof LISTS; unitId: string; importedAt: string | null }) {
  const list = LISTS[kind];
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const importList = useMutation({
    mutationFn: async (): Promise<ZoneListImportResult | AuditorListImportResult | null> => {
      setMessage(null);
      let picked;
      try {
        picked = await File.pickFileAsync({ mimeTypes: [...list.mimeTypes] });
      } catch {
        setMessage('This phone cannot choose files yet. Update the app, or import from the web.');
        return null;
      }
      if (picked.canceled) return null;
      const file = picked.result;
      let bytes: Uint8Array;
      try {
        bytes = await file.bytes();
      } catch (cause) {
        setMessage(`Could not read the file: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
      if (bytes.length > ZONE_LIST_IMPORT_MAX_BYTES) {
        setMessage('The file is larger than 5 MB.');
        return null;
      }
      // The server tells a PDF from a workbook by its first bytes, not by this name.
      return api.upload<ZoneListImportResult | AuditorListImportResult>(`/units/${unitId}/${list.path}/import`, 'file', {
        bytes,
        name: file.name || kind,
        type: file.type || 'application/octet-stream',
      });
    },
    onSuccess: async (result) => {
      if (!result) return;
      setMessage(
        [
          'existing' in result
            ? `Auditor list imported: ${result.created} new accounts, who sign in with their mobile number; ${result.existing} already had one.`
            : `Zone list imported: ${result.created} added, ${result.updated} updated, ${result.archived} archived.`,
          ...result.notes,
        ].join('\n'),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['zones'] }),
        queryClient.invalidateQueries({ queryKey: ['unit', unitId] }),
        queryClient.invalidateQueries({ queryKey: ['users'] }),
      ]);
    },
  });
  const openTemplate = () => {
    try {
      void Linking.openURL(`${new URL(api.baseUrl()).origin}/${list.template}`);
    } catch {
      setMessage('Could not open the template.');
    }
  };

  return (
    <View style={styles.importBlock}>
      {importedAt ? (
        <ConfirmAction
          title={`Import ${list.title}`}
          question={`A Zone list was imported on ${formatDate(importedAt)}. A new file replaces it: Zones not in it are archived. Their audits stay on record.`}
          confirmLabel="Choose file"
          busy={importList.isPending}
          onConfirm={() => importList.mutate()}
        />
      ) : (
        <Button title={`Import ${list.title}`} variant="secondary" busy={importList.isPending} onPress={() => importList.mutate()} />
      )}
      <Button title={`${list.title} template`} icon="file-download" variant="secondary" onPress={openTemplate} />
      {message ? <Muted>{message}</Muted> : null}
      <ErrorBanner
        message={
          importList.error instanceof ApiError || !importList.error
            ? problemMessage(importList.error)
            : `The file could not be sent: ${importList.error.message}`
        }
      />
    </View>
  );
}

/** Which Zones were audited on which day: newest day first, Zones ascending; tap an auditor to open. */
function UnitAuditDays({ unitId }: { unitId: string }) {
  const styles = useStyles();
  const router = useRouter();
  // ponytail: the newest 200 audits; page through `nextCursor` once a Unit has more.
  const audits = useQuery({
    queryKey: ['audits', 'unit', unitId],
    queryFn: () => api.get<Page<Audit>>(`/audits?limit=200&unitId=${unitId}`),
  });
  const days = auditDays(audits.data?.data ?? []);

  return (
    <Card>
      <CardHeader title="Audits by date" description={audits.data && days.length === 0 ? 'No finished audits yet.' : 'By the day each audit finished, newest first.'} />
      {audits.isPending ? <ActivityIndicator /> : null}
      {days.map(({ day, zones, audits: dayAudits }, index) => (
        <View key={day} style={[styles.item, index === days.length - 1 && styles.itemLast]}>
          <Data>{day}</Data>
          <Text style={styles.itemTitle}>{zones.length === 0 ? 'No Zones recorded' : `${zones.length === 1 ? 'Zone' : 'Zones'} ${zones.join(', ')}`}</Text>
          {dayAudits.map((audit) => (
            <Pressable
              key={audit.id}
              accessibilityRole="button"
              accessibilityLabel={`Open the audit by ${audit.auditorName} on ${day}`}
              onPress={() => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: audit.id } })}
              hitSlop={6}
              style={({ pressed }) => [styles.rowHead, pressed && styles.itemPressed]}
            >
              <Muted>
                {audit.auditorName}
                {audit.zoneCodes?.length ? ` — ${zonesLine(audit.zoneCodes)}` : ''}
              </Muted>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      ))}
      <ErrorBanner message={audits.error ? problemMessage(audits.error) : null} />
    </Card>
  );
}

const useStyles = createThemedStyles((theme) => ({
  importBlock: { gap: theme.space.sm, marginBottom: theme.space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  item: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.edgeSoft,
    gap: 2,
  },
  itemLast: { borderBottomWidth: 0, paddingBottom: 0 },
  itemPressed: { backgroundColor: theme.color.tile2 },
  itemTitle: { flexShrink: 1, fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  rowHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
  rowText: { flex: 1, minWidth: 160, gap: 2 },
  chevron: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink3 },
  adding: { marginTop: theme.space.md, gap: theme.space.sm },
  actions: { gap: theme.space.sm, marginTop: theme.space.sm },
}));
