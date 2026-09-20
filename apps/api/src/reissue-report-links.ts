import type { Page, ReportPayload, ReportSnapshot } from '@audit5s/contracts';

/**
 * Re-issue the corrective-action links in reports already generated.
 *
 * **Why this exists.** `WEB_APP_URL` is frozen into a report when its snapshot is minted
 * (§10.2): the PDF prints `{WEB_APP_URL}/ca/{token}`, and the payload keeps that exact
 * string for the life of the document. Correcting the setting afterwards changes nothing
 * about a report already issued — one generated against a LAN address carries a link only
 * that LAN can reach, permanently. The only remedy is a new version, which is what
 * `POST /reports/{id}/regenerate` produces.
 *
 * **It talks to the HTTP API, not the database.** That is the design rather than an
 * inconvenience: authorization here is the composed guard chain and the scope predicates
 * behind it (AZ-1 — no repository method runs without one), and a script reaching past
 * them would be both unauthorized and a second implementation of regeneration that nothing
 * exercises. This drives the same endpoint the Reports screen's button drives, so there is
 * exactly one path.
 *
 * **It is a dry run unless you pass `--commit`.** Three things about regeneration are not
 * reversible and are easy to discover too late:
 *
 *   1. **Nothing is ever overwritten** (RS-1). Each run appends a version, and append-only
 *      triggers mean the new rows cannot be deleted afterwards. Running it twice leaves
 *      two new versions, not one.
 *   2. **A Zone report whose findings have been answered comes back as the after-evidence
 *      report** (R-23), not as a fresh copy of the initial one. That is usually what you
 *      want, and it is still a different document — the right half carries the after photos
 *      instead of the blank frame that was there to be written on.
 *   3. **The old links keep working until they expire.** Regeneration mints new tokens; it
 *      does not revoke the previous snapshot's. A Zone Leader holding the old PDF still has
 *      a live link — one pointing at an address they cannot reach. Revoke those from the
 *      Links panel if that matters, and re-send the new PDFs either way: **regeneration
 *      notifies nobody.**
 *
 * Usage:
 *
 *   REISSUE_LOGIN_ID=... REISSUE_PASSWORD=... node dist/reissue-report-links.js [flags]
 *
 *     --api=<url>     API base, default http://127.0.0.1:3000/api/v1
 *     --expect=<url>  The address links should carry. Defaults to WEB_APP_URL.
 *     --all           Regenerate every current report, not only the unreachable ones.
 *     --commit        Actually do it. Without this nothing is written.
 */

interface Flags {
  api: string;
  expect: string;
  all: boolean;
  commit: boolean;
}

/** A report whose links do not point where they should, and why it was selected. */
interface Stale {
  snapshot: ReportSnapshot;
  /** One address actually found in the payload, for the operator to eyeball. */
  sample: string;
  links: number;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const loginId = process.env.REISSUE_LOGIN_ID;
  const password = process.env.REISSUE_PASSWORD;

  if (!loginId || !password) {
    throw new Error(
      'Set REISSUE_LOGIN_ID and REISSUE_PASSWORD to a Super Admin. Only that role holds ' +
        'report:generate (N5), so no other login can do this.',
    );
  }
  if (!flags.expect) {
    throw new Error('No --expect and no WEB_APP_URL: nothing to compare the links against.');
  }

  const expected = `${flags.expect.replace(/\/+$/, '')}/ca/`;
  console.warn(`Links should begin with ${expected}`);

  const api = await signIn(flags.api, loginId, password);

  const snapshots = await currentSnapshots(api);
  console.warn(`${snapshots.length} current report(s) — superseded versions are left alone.`);

  const stale: Stale[] = [];
  for (const snapshot of snapshots) {
    const payload = await api<ReportPayload>(`/reports/${snapshot.id}/payload`);
    const urls = correctiveActionUrls(payload);
    // A report with no nonconformity has no link to reach, so nothing to re-issue.
    if (urls.length === 0) continue;
    if (!flags.all && urls.every((url) => url.startsWith(expected))) continue;

    stale.push({ snapshot, sample: urls[0]!, links: urls.length });
  }

  if (stale.length === 0) {
    console.warn(
      flags.all
        ? 'No current reports carry corrective-action links.'
        : 'Every current report already points at that address.',
    );
    return;
  }

  console.warn(`\n${stale.length} report(s) to re-issue:\n`);
  for (const { snapshot, sample, links } of stale) {
    console.warn(
      `  ${snapshot.kind} v${snapshot.version}  ${snapshot.id}  ` +
        `${links} link(s)  e.g. ${sample.slice(0, 60)}…`,
    );
  }

  if (!flags.commit) {
    console.warn(
      '\nDry run — nothing was written. Re-run with --commit to regenerate.\n' +
        'Each one appends a version that cannot be deleted afterwards, and a Zone report\n' +
        'whose findings have been answered comes back as the after-evidence report (R-23).',
    );
    return;
  }

  let failed = 0;
  for (const { snapshot } of stale) {
    process.stderr.write(`  ${snapshot.kind} v${snapshot.version} -> `);
    try {
      const created = await api<ReportSnapshot>(`/reports/${snapshot.id}/regenerate`, {
        method: 'POST',
      });
      const settled = await waitForRender(api, created.id);
      if (settled.status === 'READY') {
        console.warn(`v${settled.version} READY (${settled.pageCount ?? '?'} pages)`);
      } else {
        failed += 1;
        console.warn(
          `v${settled.version} ${settled.status} — ${settled.failedReason ?? 'no reason given'}`,
        );
      }
    } catch (error) {
      failed += 1;
      console.warn(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.warn(
    `\nRe-issued ${stale.length - failed} of ${stale.length}. The new PDFs are not sent ` +
      'anywhere — download and forward them as before, and revoke the old links from the ' +
      'Links panel if the stale ones should stop resolving.',
  );
  if (failed > 0) process.exitCode = 1;
}

/** A thin authenticated client. The access token lives here and is never printed. */
type Client = <T>(path: string, init?: RequestInit) => Promise<T>;

async function signIn(base: string, loginId: string, password: string): Promise<Client> {
  let response: Response;
  try {
    response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
  } catch {
    // Node's bare "fetch failed" names neither the address nor the cause, and the usual
    // cause is that the API is not running yet — or is still running with the old config.
    throw new Error(
      `No API at ${base}. Start it (and worker-report, which does the rendering) with the ` +
        'corrected WEB_APP_URL, or pass --api=<url>.',
    );
  }
  if (!response.ok) {
    throw new Error(`Sign-in failed (${response.status}). Check the credentials and the role.`);
  }
  const { accessToken } = (await response.json()) as { accessToken: string };

  return async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const result = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        // Every mutating endpoint requires one (STACK.md §5). A retry of a regenerate that
        // timed out must not append a second version.
        ...(init.method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
      },
    });
    if (!result.ok) {
      const problem = (await result.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(problem?.detail ?? `${init.method ?? 'GET'} ${path} -> ${result.status}`);
    }
    return (await result.json()) as T;
  };
}

/**
 * Every report that is the head of its chain.
 *
 * A snapshot is superseded when a later one names it in `supersedesSnapshotId`. Those are
 * skipped deliberately: regenerating an old version would take a superseded document as
 * the source for a new head, quietly reverting whatever the later version changed.
 */
async function currentSnapshots(api: Client): Promise<ReportSnapshot[]> {
  const all: ReportSnapshot[] = [];
  let cursor: string | null = null;

  do {
    const page: Page<ReportSnapshot> = await api<Page<ReportSnapshot>>(
      `/reports?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    all.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  const superseded = new Set(all.map((row) => row.supersedesSnapshotId).filter(Boolean));
  return all.filter((row) => !superseded.has(row.id));
}

function correctiveActionUrls(payload: ReportPayload): string[] {
  const urls: string[] = [];
  for (const zone of payload.zones) {
    for (const item of zone.nonconformities) {
      if (item.correctiveActionUrl) urls.push(item.correctiveActionUrl);
    }
  }
  return urls;
}

/**
 * Poll until the worker has finished with it.
 *
 * Generation returns `202` and a `QUEUED` row — the render happens in `worker-report`, so
 * a script that stopped here would report success for a report that had not been drawn
 * yet. The ceiling is the job's own timeout plus its one retry, past which the answer is
 * whatever the row says rather than an exception.
 */
async function waitForRender(api: Client, snapshotId: string): Promise<ReportSnapshot> {
  const deadline = Date.now() + 300_000;
  let snapshot = await api<ReportSnapshot>(`/reports/${snapshotId}`);

  while (
    (snapshot.status === 'QUEUED' || snapshot.status === 'RENDERING') &&
    Date.now() < deadline
  ) {
    await new Promise((resume) => setTimeout(resume, 2_000));
    snapshot = await api<ReportSnapshot>(`/reports/${snapshotId}`);
  }
  return snapshot;
}

function parseFlags(argv: string[]): Flags {
  const value = (name: string): string | undefined =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');

  return {
    api: value('api') ?? process.env.REISSUE_API_URL ?? 'http://127.0.0.1:3000/api/v1',
    expect: value('expect') ?? process.env.WEB_APP_URL ?? '',
    all: argv.includes('--all'),
    commit: argv.includes('--commit'),
  };
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
