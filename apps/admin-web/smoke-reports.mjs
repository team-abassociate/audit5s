import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4173';
const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4173'], {
  stdio: 'ignore',
});

async function ready() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vite preview did not start');
}

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  unit: '00000000-0000-4000-8000-000000000002',
  report: '00000000-0000-4000-8000-000000000003',
  action: '00000000-0000-4000-8000-000000000004',
};
const now = '2026-09-12T08:30:00.000Z';
ids.audit = '00000000-0000-4000-8000-000000000006';
ids.auditZoneOne = '00000000-0000-4000-8000-000000000007';
ids.auditZoneTwo = '00000000-0000-4000-8000-000000000008';
const finishedAudit = {
  id: ids.audit,
  unitId: ids.unit,
  unitName: 'Nashik Plant',
  auditType: 'EXTERNAL_5S',
  status: 'CLOSED',
  scored: true,
  auditorName: 'Priya Nair',
  completedAt: now,
  totals: { applicableQuestions: 100, naQuestions: 0, rawScore: 120, maxScore: 200, scorePercentage: 60 },
};
const generated = [];

await ready();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera'] });
const page = await context.newPage();
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.route('**/api/v1/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/v1/public/corrective-actions/smoke-token') {
    return json({
      correctiveActionId: ids.action,
      unitName: 'Nashik Plant',
      zoneCode: 'Z-07',
      zoneName: 'Press shop',
      auditDate: now,
      auditorName: 'Priya Nair',
      questionGlobalOrder: null,
      questionText: null,
      section: null,
      dueAt: now,
      findingRemark: 'Walk-by observation',
      beforePhotoUrl: null,
      issuedToName: 'Zoe Leader',
      alreadySubmitted: null,
      submittable: true,
    });
  }
  if (path === '/api/v1/auth/me') {
    return json({
      user: {
        id: ids.user,
        loginId: 'SA0101',
        fullName: 'Sam Admin',
        phoneE164: '+919000000101',
        email: null,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        mustResetPassword: false,
        bootstrapExpiresAt: null,
        lastLoginAt: now,
      },
      scope: {
        role: 'SUPER_ADMIN',
        unitIds: [],
        organizationWide: true,
        permissions: ['report:generate', 'report:read_snapshot'],
      },
    });
  }
  if (path === '/api/v1/units') {
    return json({
      data: [{ id: ids.unit, name: 'Nashik Plant' }],
      nextCursor: null,
    });
  }
  if (path === '/api/v1/reports') {
    return json({
      data: [{
        id: ids.report,
        kind: 'INITIAL_ZONE',
        version: 1,
        supersedesSnapshotId: null,
        generatedAt: now,
        generatedByName: 'Sam Admin',
        status: 'READY',
        pageCount: 2,
        failedReason: null,
      }],
      nextCursor: null,
    });
  }
  if (path === '/api/v1/audits') return json({ data: [finishedAudit], nextCursor: null });
  // The unit summary picker lists each finished audit's Zones from its score summary.
  if (path === `/api/v1/audits/${ids.audit}/summary`) {
    const zone = (auditZoneId, zoneCode, zoneName, pct) => ({
      auditId: ids.audit,
      auditZoneId,
      zoneCode,
      zoneName,
      checklistTemplateName: 'Production',
      status: 'COMPLETED',
      totals: { applicableQuestions: 50, naQuestions: 0, rawScore: pct, maxScore: 100, scorePercentage: pct },
      sections: [],
    });
    return json({
      scored: true,
      audit: { auditId: ids.audit, auditZoneId: null, totals: finishedAudit.totals, sections: [] },
      zones: [zone(ids.auditZoneOne, '1', 'Press shop', 62), zone(ids.auditZoneTwo, '2', 'Stores', 58)],
    });
  }
  if (path === '/api/v1/reports/generate') {
    generated.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: ids.report, version: 2, kind: 'MULTI_ZONE_SUMMARY' }),
    });
  }
  if (path === `/api/v1/units/${ids.unit}/zones`) {
    return json({
      data: [
        {
          id: '00000000-0000-4000-8000-000000000005',
          unitId: ids.unit,
          code: 'Z-07',
          name: 'Press shop',
          description: null,
          departmentHint: null,
          defaultChecklistTemplateId: null,
          zoneLeaderId: null,
          zoneLeaderName: 'Zoe Leader',
          sortOrder: 1,
          version: 1,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: null,
    });
  }
  if (path === `/api/v1/reports/${ids.report}/tokens`) return json([]);
  if (path === '/api/v1/notifications') return json({ data: [], nextCursor: null, unreadCount: 0 });
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
});

try {
  await page.goto(`${base}/ca/smoke-token`);
  await page.getByRole('heading', { name: 'Walk-by observation' }).waitFor();
  assert.equal(await page.locator('input[type=file]').count(), 0);
  assert.equal(await page.locator('meta[name=referrer]').getAttribute('content'), 'no-referrer');
  const openCamera = page.locator('button', { hasText: 'Open the camera' });
  await openCamera.scrollIntoViewIfNeeded();
  await openCamera.click({ force: true });
  const takePhoto = page.locator('button', { hasText: 'Take the photograph' });
  await takePhoto.waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const video = globalThis.document.querySelector('video');
    return video instanceof globalThis.HTMLVideoElement && video.videoWidth > 0 && video.videoHeight > 0;
  });
  await takePhoto.click({ force: true });
  await page.getByAltText('The work you photographed').waitFor();

  await page.evaluate(() => globalThis.localStorage.setItem('audit5s.session', JSON.stringify({
    accessToken: 'smoke-access',
    refreshToken: 'smoke-refresh',
  })));
  await page.goto(`${base}/reports`);
  // The shell's topbar carries the page's h1 (GEMBA-BOARD.md §5) and the section below it
  // has its own heading, so the level is what makes this unambiguous.
  await page.getByRole('heading', { name: 'Reports', level: 1 }).waitFor();
  await page.getByRole('cell', { name: 'Initial Zone report' }).waitFor();
  await page.getByRole('button', { name: 'Links' }).click();
  await page.getByRole('heading', { name: 'Links — Initial Zone report v1' }).waitFor();

  // The unit summary is chosen audited Zone by audited Zone, not handed every Zone.
  await page.getByRole('button', { name: 'Generate unit summary report' }).click();
  await page.getByText('Priya Nair · 2 Zones').waitFor();
  await page.getByRole('checkbox', { name: /Stores/ }).check();
  await page.getByRole('button', { name: 'Generate summary of 1 Zone' }).click();
  await page.getByText(/Summary of 1 Zone queued/).waitFor();
  assert.deepEqual(generated, [
    { kind: 'MULTI_ZONE_SUMMARY', unitId: ids.unit, selectedAuditZoneIds: [ids.auditZoneTwo] },
  ]);
  assert.deepEqual(errors, []);
  console.log('reports and /ca camera smoke passed with no console errors');
} finally {
  await browser.close();
  preview.kill('SIGTERM');
}
