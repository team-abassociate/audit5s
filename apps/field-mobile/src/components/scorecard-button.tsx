import { Linking } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import type { ScorecardExport } from '@audit5s/contracts';
import { api, problemMessage } from '../lib/api';
import { Button, ErrorBanner } from './ui';

/**
 * R-80: the score card as a PDF, named for the Unit and the Zone. Queued on the server,
 * polled until printed, then opened from its short-lived link — the Kaizen Sheet's way.
 */
export function ScorecardButton({ auditId }: { auditId: string }) {
  const download = useMutation({
    mutationFn: async () => {
      const path = `/audits/${encodeURIComponent(auditId)}/scorecard`;
      let job = await api.post<ScorecardExport>(path);
      for (let tries = 0; job.status === 'QUEUED' && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await api.get<ScorecardExport>(`${path}/${job.exportId}`);
      }
      if (job.status !== 'READY' || !job.downloadUrl) throw new Error('The score card could not be made. Try again.');
      await Linking.openURL(job.downloadUrl);
    },
  });
  return (
    <>
      <Button
        icon="file-download"
        title={download.isPending ? 'Preparing the score card…' : 'Download score card'}
        variant="secondary"
        busy={download.isPending}
        onPress={() => download.mutate()}
      />
      <ErrorBanner message={download.error ? (problemMessage(download.error) ?? download.error.message) : null} />
    </>
  );
}
