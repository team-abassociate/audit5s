import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { listResumableAudits, resumeCursor, resumeLocalAudit, type ResumableAudit } from './db/audit.repository';
import { useLocalDatabase } from './db/provider';

/** The audits open on this device — the ones Resume can take the auditor back into. */
export function useResumableAudits() {
  const database = useLocalDatabase();
  return useQuery({ queryKey: ['local', 'resumable-audits'], queryFn: () => listResumableAudits(database) });
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
