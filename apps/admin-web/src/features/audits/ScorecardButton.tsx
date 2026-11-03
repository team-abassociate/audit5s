import { Download } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { ScorecardExport } from '@audit5s/contracts';
import { Button, ErrorNotice } from '@/components/ui';
import { api } from '@/lib/api';
import { savePdf } from '@/features/reports/report-pdf';

/**
 * R-80: the audit's score card as a PDF, named for the Unit and the Zone — queued, polled
 * until printed, then saved under its own name, as the Kaizen Sheet is.
 */
export function ScorecardButton({ auditId }: { auditId: string }) {
  const download = useMutation({
    mutationFn: async () => {
      const path = `/audits/${auditId}/scorecard`;
      let job = await api.post<ScorecardExport>(path);
      for (let tries = 0; job.status === 'QUEUED' && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await api.get<ScorecardExport>(`${path}/${job.exportId}`);
      }
      if (job.status !== 'READY' || !job.downloadUrl) throw new Error('The score card could not be made. Try again.');
      const response = await fetch(job.downloadUrl);
      if (!response.ok) throw new Error(`The score card could not be fetched (HTTP ${response.status}).`);
      savePdf({ bytes: await response.arrayBuffer(), fileName: job.fileName, checksum: 'unchecked' });
    },
  });
  return (
    <div className="space-y-2">
      <ErrorNotice error={download.error} />
      <Button
        variant="secondary"
        className="inline-flex items-center gap-1.5"
        disabled={download.isPending}
        onClick={() => download.mutate()}
      >
        <Download size={15} strokeWidth={2.25} aria-hidden />
        {download.isPending ? 'Preparing the score card…' : 'Download score card'}
      </Button>
    </div>
  );
}
