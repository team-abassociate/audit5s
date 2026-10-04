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

/**
 * A real, minimal PDF — `pages` blank A4 sheets — so the preview is driven through PDF.js
 * and its worker as the production build serves them, not stubbed.
 */
function tinyPdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >>'),
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const at = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
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

/** A report as `GET /reports` returns it: named by its `subject`, read from the payload. */
function snapshot({ subject = {}, ...overrides }) {
  return {
    supersedesSnapshotId: null,
    unitId: ids.unit,
    auditId: ids.audit,
    auditZoneId: null,
    selectedZoneIds: null,
    selectedAuditZoneIds: null,
    assignmentGroupId: null,
    payloadSchemaVersion: 1,
    templateVersion: '1',
    status: 'READY',
    pdfObjectKey: null,
    pdfChecksumSha256: null,
    pageCount: 2,
    generatedByUserId: ids.user,
    generatedByName: 'Sam Admin',
    generatedAt: now,
    renderedAt: now,
    failedReason: null,
    withdrawnAt: null,
    ...overrides,
    subject: {
      unitName: 'Nashik Plant',
      zoneLabel: 'Zone 1 — Press shop',
      zoneCount: 1,
      auditorNames: ['Priya Nair'],
      auditedFrom: now,
      auditedTo: now,
      ...subject,
    },
  };
}

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
      data: [snapshot({ id: ids.report, kind: 'INITIAL_ZONE', version: 1, auditZoneId: ids.auditZoneOne })],
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
      body: JSON.stringify(
        snapshot({
          id: '00000000-0000-4000-8000-000000000009',
          kind: 'MULTI_ZONE_SUMMARY',
          version: 1,
          status: 'QUEUED',
          auditId: null,
          auditZoneId: null,
          selectedAuditZoneIds: [ids.auditZoneTwo],
          subject: { zoneLabel: null, zoneCount: 1 },
        }),
      ),
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
  if (path === `/api/v1/reports/${ids.report}/download-url`) {
    return json({
      url: `${base}/api/v1/__smoke/report.pdf`,
      expiresIn: 300,
      checksumSha256: null,
      fileName: 'Nashik Plant - Zone 1 - Press shop - Initial - 12 Sep 2026 - v1.pdf',
    });
  }
  if (path === '/api/v1/__smoke/report.pdf') {
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: tinyPdf(2) });
  }
  if (path === '/api/v1/notifications') return json({ data: [], nextCursor: null, unreadCount: 0 });
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
});

try {
  await page.goto(`${base}/ca/smoke-token`);
  await page.getByRole('heading', { name: 'Walk-by observation' }).waitFor();
  // R-40: a finding offers the gallery beside the camera — one file input, images only.
  assert.equal(await page.locator('input[type=file]').count(), 1);
  assert.equal(await page.locator('input[type=file]').getAttribute('accept'), 'image/*');
  await page.locator('button', { hasText: 'Choose from gallery' }).waitFor({ state: 'attached' });
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
  await page.getByAltText('The photograph you chose').waitFor();

  await page.evaluate(() => globalThis.localStorage.setItem('audit5s.session', JSON.stringify({
    accessToken: 'smoke-access',
    refreshToken: 'smoke-refresh',
  })));
  await page.goto(`${base}/reports`);
  // The shell's topbar carries the page's h1 (GEMBA-BOARD.md §5) and the section below it
  // has its own heading, so the level is what makes this unambiguous.
  await page.getByRole('heading', { name: 'Reports', level: 1 }).waitFor();
  // The library names a report by what it covers, filed under the audit it came from.
  await page.getByText('Zone 1 — Press shop').waitFor();
  await page.getByText(/Audit finished .* · Priya Nair/).waitFor();
  // R4: Download is the row's one visible action; Regenerate and Delete wait behind "⋯".
  await page.getByRole('button', { name: 'Download', exact: true }).waitFor();
  const more = page.getByRole('button', { name: /^More actions for Zone 1 — Press shop.* v1$/ });
  await more.click();
  await page.getByRole('menuitem', { name: /Regenerate/ }).waitFor();
  await page.getByRole('menuitem', { name: /Delete v1/ }).click();
  // Delete asks first, naming the version, with Cancel holding focus.
  await page.getByRole('alertdialog', { name: /^Delete v1 of Zone 1 — Press shop.*\?$/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });

  // A click on the report opens its PDF beside the list, drawn by PDF.js from the built worker.
  await page.getByText('Zone 1 — Press shop').click();
  const panel = page.getByRole('complementary', { name: /^Preview of / });
  await panel.waitFor();
  await panel.locator('.gb-pdf-page[data-drawn]').first().waitFor();
  await panel.getByText('1 / 2').waitFor();
  // R3: beside the open preview the list drops Edition, Version and Generated, and Download
  // is an icon still named for what it does.
  assert.equal(await page.locator('tr[data-snapshot] .gb-btn--act-icon').count(), 1);
  assert.equal(await page.locator('thead th').count(), 3);
  // Expand lays the report over the page at 100% — the page's own view, not full screen.
  await panel.getByRole('button', { name: 'Expand, at 100%' }).click();
  assert.equal(await panel.getByRole('combobox', { name: 'Zoom' }).inputValue(), '1');
  assert.equal(await page.evaluate(() => globalThis.document.fullscreenElement), null);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Expand, at 100%' }).waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });

  // One New report dialog: the kind, then the scope. The summary names its Unit itself.
  await page.getByRole('button', { name: 'New report' }).first().click();
  await page.getByRole('heading', { name: 'New report' }).waitFor();
  await page.getByRole('radio', { name: /Unit summary/ }).check();
  // The shell's Unit scope is a combobox too; this is the dialog's own.
  const dialog = page.getByRole('dialog', { name: 'New report' });
  await dialog.getByRole('combobox', { name: /^Unit/ }).click();
  await dialog.getByRole('option', { name: 'Nashik Plant' }).click();

  // The unit summary is chosen audited Zone by audited Zone, not handed every Zone.
  await page.getByText('Priya Nair · 2 Zones').waitFor();
  await page.getByRole('checkbox', { name: /Stores/ }).check();
  await page.getByRole('button', { name: 'Generate summary of 1 Zone' }).click();
  // The dialog closes and the slip says what was queued, in the report's own name.
  await page.getByText('Report queued').waitFor();
  await page.getByText(/Nashik Plant · Unit summary of 1 Zone/).waitFor();
  assert.deepEqual(generated, [
    { kind: 'MULTI_ZONE_SUMMARY', unitId: ids.unit, selectedAuditZoneIds: [ids.auditZoneTwo] },
  ]);
  assert.deepEqual(errors, []);
  console.log('reports and /ca camera smoke passed with no console errors');
} finally {
  await browser.close();
  preview.kill('SIGTERM');
}
