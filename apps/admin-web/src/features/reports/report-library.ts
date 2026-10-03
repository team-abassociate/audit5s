import type { ReportSnapshot } from '@audit5s/contracts';
import { formatDate } from '@audit5s/domain';
import { REPORT_EDITION_LABEL } from '@/lib/labels';

/**
 * The Reports page as a library of documents rather than a log of renders.
 *
 * A Super Admin looks for "the report of Zone 2 from ABC's audit on the 30th", not for
 * "the eleventh Initial Zone report v2 in a list of forty". So the history is folded:
 *
 * - A **document** is one thing a client receives — one audited Zone's report, or one
 *   summary of one selection of Zones — with its versions. Its newest version is the
 *   current one; the rest are kept (§10.5) and shown on request.
 * - A **group** is what the documents are filed under: the audit a Zone report came from,
 *   or the Unit a summary covers.
 *
 * A Zone's version sequence spans both editions (§10.5: an after-evidence report is v2 *of
 * that Zone's report*), so one document can hold an Initial v1 and an After-evidence v2.
 * Every summary of a Unit shares one sequence too, but two summaries of different Zones are
 * different documents — so a summary document is keyed by its exact selection, which a
 * regeneration keeps.
 */

export interface ReportDocument {
  key: string;
  latest: ReportSnapshot;
  /** Older versions, newest first. */
  earlier: ReportSnapshot[];
}

export interface ReportGroup {
  key: string;
  kind: 'AUDIT' | 'SUMMARIES';
  unitId: string;
  unitName: string;
  /** The audit's finish, for an audit group; null for a Unit's summaries. */
  auditedAt: string | null;
  auditorNames: string[];
  documents: ReportDocument[];
  /** The newest generation inside the group, which orders the groups. */
  lastGeneratedAt: string;
}

export type TypeFilter = 'ALL' | 'ZONE' | 'SUMMARY';
export type StatusFilter = 'ALL' | 'READY' | 'IN_PROGRESS' | 'FAILED';

export interface LibraryFilters {
  unitId: string;
  type: TypeFilter;
  status: StatusFilter;
  search: string;
}

export const NO_FILTERS: LibraryFilters = { unitId: '', type: 'ALL', status: 'ALL', search: '' };

export function isFiltered(filters: LibraryFilters): boolean {
  return (
    filters.unitId !== '' ||
    filters.type !== 'ALL' ||
    filters.status !== 'ALL' ||
    filters.search.trim() !== ''
  );
}

export function isInFlight(snapshot: ReportSnapshot): boolean {
  return snapshot.status === 'QUEUED' || snapshot.status === 'RENDERING';
}

/** The document of one audited Zone — every edition and version of its report. */
export function zoneDocumentKey(auditZoneId: string | null): string {
  return `zone:${auditZoneId}`;
}

/** The key of the document a snapshot belongs to. */
export function documentKey(snapshot: ReportSnapshot): string {
  if (snapshot.kind !== 'MULTI_ZONE_SUMMARY') return zoneDocumentKey(snapshot.auditZoneId);
  const selection = [...(snapshot.selectedAuditZoneIds ?? snapshot.selectedZoneIds ?? [])].sort();
  return `summary:${snapshot.unitId}:${snapshot.assignmentGroupId ?? ''}:${selection.join(',')}`;
}

function groupKey(snapshot: ReportSnapshot): string {
  return snapshot.kind === 'MULTI_ZONE_SUMMARY'
    ? `summaries:${snapshot.unitId}`
    : `audit:${snapshot.auditId ?? snapshot.auditZoneId}`;
}

/** Folds the flat history into groups of documents, newest activity first. */
export function buildLibrary(snapshots: readonly ReportSnapshot[]): ReportGroup[] {
  const documents = new Map<string, ReportSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = documentKey(snapshot);
    documents.set(key, [...(documents.get(key) ?? []), snapshot]);
  }

  const groups = new Map<string, ReportGroup>();
  for (const [key, versions] of documents) {
    versions.sort(byNewestVersion);
    const [latest, ...earlier] = versions as [ReportSnapshot, ...ReportSnapshot[]];
    const document: ReportDocument = { key, latest, earlier };
    const newest = versions.reduce(
      (at, each) => (each.generatedAt > at ? each.generatedAt : at),
      latest.generatedAt,
    );

    const gKey = groupKey(latest);
    const group = groups.get(gKey);
    if (group) {
      group.documents.push(document);
      if (newest > group.lastGeneratedAt) group.lastGeneratedAt = newest;
      for (const name of latest.subject.auditorNames) {
        if (!group.auditorNames.includes(name)) group.auditorNames.push(name);
      }
      continue;
    }
    const summaries = latest.kind === 'MULTI_ZONE_SUMMARY';
    groups.set(gKey, {
      key: gKey,
      kind: summaries ? 'SUMMARIES' : 'AUDIT',
      unitId: latest.unitId,
      unitName: latest.subject.unitName,
      auditedAt: summaries ? null : latest.subject.auditedTo,
      auditorNames: summaries ? [] : [...latest.subject.auditorNames],
      documents: [document],
      lastGeneratedAt: newest,
    });
  }

  for (const group of groups.values()) {
    group.documents.sort(
      group.kind === 'AUDIT'
        ? (a, b) => naturalCompare(a.latest.subject.zoneLabel ?? '', b.latest.subject.zoneLabel ?? '')
        : (a, b) => b.latest.generatedAt.localeCompare(a.latest.generatedAt),
    );
  }

  return [...groups.values()].sort((a, b) => b.lastGeneratedAt.localeCompare(a.lastGeneratedAt));
}

/** Keeps the documents that match; a group with none left is dropped. */
export function filterLibrary(groups: readonly ReportGroup[], filters: LibraryFilters): ReportGroup[] {
  const words = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

  const keep = (group: ReportGroup, document: ReportDocument): boolean => {
    const { latest } = document;
    if (filters.unitId && group.unitId !== filters.unitId) return false;
    if (filters.type === 'ZONE' && latest.kind === 'MULTI_ZONE_SUMMARY') return false;
    if (filters.type === 'SUMMARY' && latest.kind !== 'MULTI_ZONE_SUMMARY') return false;
    if (filters.status === 'READY' && latest.status !== 'READY') return false;
    if (filters.status === 'IN_PROGRESS' && !isInFlight(latest)) return false;
    if (filters.status === 'FAILED' && latest.status !== 'FAILED') return false;
    if (words.length === 0) return true;
    const haystack = [
      latest.subject.unitName,
      latest.subject.zoneLabel ?? '',
      ...latest.subject.auditorNames,
      REPORT_EDITION_LABEL[latest.kind],
    ]
      .join(' ')
      .toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  };

  return groups
    .map((group) => ({ ...group, documents: group.documents.filter((doc) => keep(group, doc)) }))
    .filter((group) => group.documents.length > 0);
}

/** The Units that have reports, for the Unit filter — named as their reports name them. */
export function unitsOf(snapshots: readonly ReportSnapshot[]): Array<{ id: string; name: string }> {
  const names = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (!names.has(snapshot.unitId)) names.set(snapshot.unitId, snapshot.subject.unitName);
  }
  return [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a document is called in its row: its Zone, or the Zones a summary covers. */
export function documentTitle(snapshot: ReportSnapshot): string {
  const { subject } = snapshot;
  if (snapshot.kind !== 'MULTI_ZONE_SUMMARY') return subject.zoneLabel ?? 'Zone report';
  const zones = `${subject.zoneCount} Zone${subject.zoneCount === 1 ? '' : 's'}`;
  return subject.auditedFrom ? `${zones} · audited ${auditedSpan(subject)}` : zones;
}

/** A report's full name, for a slip or a dialog: `ABC · Zone 2 — Press · After evidence`. */
export function reportName(snapshot: ReportSnapshot): string {
  return snapshot.kind === 'MULTI_ZONE_SUMMARY'
    ? `${snapshot.subject.unitName} · Unit summary of ${documentTitle(snapshot)}`
    : `${snapshot.subject.unitName} · ${documentTitle(snapshot)} · ${REPORT_EDITION_LABEL[snapshot.kind]}`;
}

function auditedSpan(subject: ReportSnapshot['subject']): string {
  const from = formatDate(subject.auditedFrom);
  const to = formatDate(subject.auditedTo);
  return from === to ? from : `${from} – ${to}`;
}

function byNewestVersion(a: ReportSnapshot, b: ReportSnapshot): number {
  return b.version - a.version || b.generatedAt.localeCompare(a.generatedAt);
}

/** `Zone 2` before `Zone 10`. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
