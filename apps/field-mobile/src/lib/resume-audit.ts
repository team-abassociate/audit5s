import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useAuditsElsewhere } from './audits-elsewhere';
import { listResumableAudits, resumeCursor, resumeLocalAudit, type ResumableAudit } from './db/audit.repository';
import { useLocalDatabase } from './db/provider';

/**
 * The audits open on this device — the ones Resume can take the auditor back into.
 *
 * R-92: less any the server says another device now holds. This phone's copy of one of those
 * is stale, and resuming it would only be refused; it is offered instead as an audit open on
 * another device, which brings the current copy here.
 */
export function useResumableAudits() {
  const database = useLocalDatabase();
  const elsewhere = useAuditsElsewhere();
  const held = (elsewhere.data ?? []).map((item) => item.audit.id).join(',');
  const select = useCallback(
    (rows: ResumableAudit[]) => (held ? rows.filter((row) => !held.split(',').includes(row.id)) : rows),
    [held],
  );
  return useQuery({ queryKey: ['local', 'resumable-audits'], queryFn: () => listResumableAudits(database), select });
}

/**
 * Back into the audit, at the question it stopped on — for every screen that lists it: the
 * field Overview, and a Coordinator's or Super Admin's Overview and Audits boards.
 *
 * A paused audit is resumed first — the status has to move before the questionnaire will
 * accept another answer — and then the cursor decides where to land: the Zone that was
 * open, or the Zone list when there is none, which is the case for an audit that was
 * started and never opened a Zone.
 */
export function useResumeAudit() {
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async (audit: Pick<ResumableAudit, 'id' | 'status' | 'auditType'>) => {
      if (audit.status === 'PAUSED') await resumeLocalAudit(database, audit.id);
      return { audit, cursor: await resumeCursor(database, audit.id) };
    },
    onSuccess: async ({ audit, cursor }) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      if (cursor.auditZoneId) {
        router.push({
          pathname: audit.auditType === 'WALK_BY' ? '/walk-by/[auditZoneId]' : '/audit/[auditZoneId]',
          params: { auditZoneId: cursor.auditZoneId },
        });
        return;
      }
      router.push({ pathname: '/audit/zones/[auditId]', params: { auditId: audit.id } });
    },
  });
}
