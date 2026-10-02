import type { QueryClient } from '@tanstack/react-query';
import type { ReportDownloadUrl, ReportSnapshot } from '@audit5s/contracts';
import { api } from '@/lib/api';

/**
 * A report's PDF, held in memory for the preview panel and the Download button.
 *
 * The bytes are fetched from the short-TTL presigned GET straight away and kept, rather
 * than the URL being kept: the URL is a live credential (the API's logger strips it for that
 * reason) and expires in five minutes, so it is used once, here, and never reaches the DOM.
 * Preview, Download and Open in new tab then all work from the same bytes, without a second
 * request.
 */
export interface ReportPdf {
  bytes: ArrayBuffer;
  fileName: string;
  /**
   * The bytes hashed in the browser against the checksum recorded when the report was
   * issued. `unchecked` when there is nothing to compare against, or no Web Crypto — it
   * exists only in a secure context, so a dashboard opened over plain HTTP on the LAN
   * cannot check, and says nothing rather than claiming either way.
   */
  checksum: 'verified' | 'mismatch' | 'unchecked';
}

export const reportPdfKey = (snapshotId: string) => ['report-pdf', snapshotId] as const;

/** Every cached PDF; cleared when the panel closes, so a closed preview holds no bytes. */
export const REPORT_PDF_ROOT = ['report-pdf'] as const;

export async function fetchReportPdf(snapshotId: string): Promise<ReportPdf> {
  const link = await api.get<ReportDownloadUrl>(`/reports/${snapshotId}/download-url`);
  const response = await fetch(link.url);
  if (!response.ok) throw new Error(`The PDF could not be fetched (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  return { bytes, fileName: link.fileName, checksum: await check(bytes, link.checksumSha256) };
}

async function check(bytes: ArrayBuffer, expected: string | null): Promise<ReportPdf['checksum']> {
  const subtle = globalThis.crypto?.subtle;
  if (!expected || !subtle) return 'unchecked';
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex === expected.toLowerCase() ? 'verified' : 'mismatch';
}

/** Through the query cache, so a report already open in the preview downloads instantly. */
export function loadReportPdf(queryClient: QueryClient, snapshot: ReportSnapshot): Promise<ReportPdf> {
  return queryClient.fetchQuery({
    queryKey: reportPdfKey(snapshot.id),
    queryFn: () => fetchReportPdf(snapshot.id),
    staleTime: Infinity,
  });
}

function blobUrl(pdf: ReportPdf): string {
  return URL.createObjectURL(new Blob([pdf.bytes], { type: 'application/pdf' }));
}

/** Saves under the report's own name — `Unit - Zone - kind - date - vN.pdf`. */
export function savePdf(pdf: ReportPdf): void {
  const url = blobUrl(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = pdf.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on a timer rather than immediately: the browser starts the save asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The browser's own viewer, for printing or a second monitor. */
export function openPdfInTab(pdf: ReportPdf): void {
  const url = blobUrl(pdf);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
