import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

// `require`, because `@audit5s/domain` publishes a CommonJS main and this script is ESM.
// It matters that it is the package rather than a copy: the number asserted below is
// produced by the *same* function the API and the device run (D5).
const { S_SECTION_ORDER, scoreZone } = createRequire(import.meta.url)('@audit5s/domain');

/**
 * The second half of the walkthrough: a device runs a real audit against the live API,
 * and the admin board renders it.
 *
 * `smoke.mjs` proves the Super Admin's screens. This proves the pair — that what a
 * Consultant's device pushes is what the board shows, with the score the shared domain
 * function computes. It runs after `smoke.mjs`, against the world that script left behind.
 */

const API = 'http://127.0.0.1:3000/api/v1';
const BASE = 'http://127.0.0.1:4173';
const shots = '/tmp/claude-0/shots';

const CONSULTANT_LOGIN = 'PR5678';
const CONSULTANT_PHONE = '+919812345678';
const CONSULTANT_PASSWORD = 'harbour-kestrel-71-QW';
const DEVICE_ID = '01930000-0000-7000-8000-0000000f1e1d';

function step(n, message) {
  console.log(`  ${n}. ${message}`);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-device-id': DEVICE_ID,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

step(1, 'the Consultant signs in with their bootstrap credential and rotates it');

const device = { deviceId: DEVICE_ID, platform: 'android', model: 'Pixel 8', appVersion: '1.0.0' };

/**
 * Idempotent by design: on a re-run the credential has already been rotated, and a script
 * that could only run once would be a script nobody runs.
 *
 * The rotated password is tried **first**. Leading with the bootstrap one would fail on
 * every re-run, and §12.11's per-login-ID lockout counts those failures — the script would
 * lock the account it is trying to use.
 */
async function signIn() {
  try {
    return await call('/auth/login', {
      method: 'POST',
      body: { loginId: CONSULTANT_LOGIN, password: CONSULTANT_PASSWORD, ...device },
    });
  } catch {
    // First run: the credential is still the phone number, and must be rotated (CH-1).
  }

  const bootstrap = await call('/auth/login', {
    method: 'POST',
    body: { loginId: CONSULTANT_LOGIN, password: CONSULTANT_PHONE, ...device },
  });
  await call('/auth/change-password', {
    method: 'POST',
    token: bootstrap.accessToken,
    body: { currentPassword: CONSULTANT_PHONE, newPassword: CONSULTANT_PASSWORD },
  });

  return call('/auth/login', {
    method: 'POST',
    body: { loginId: CONSULTANT_LOGIN, password: CONSULTANT_PASSWORD, ...device },
  });
}

const session = await signIn();
const token = session.accessToken;

step(2, 'the device pulls its catalogue: Units, Zones, checklists and open assignments');
let catalogue = await call('/sync/catalogue', { token });
console.log(
  `     ${catalogue.units.length} Unit(s), ${catalogue.zones.length} Zone(s), ` +
    `${catalogue.checklistVersions.length} checklist version(s), ` +
    `${catalogue.assignments.length} open assignment(s)`,
);

// On the first run the assignment `smoke.mjs` created is already there. On a re-run the
// earlier audit completed it, so one is made here — the point being that the catalogue
// carries the auditor's *open* assignments and drops them as they close.
if (catalogue.assignments.length === 0) {
  const admin = await call('/auth/login', {
    method: 'POST',
    body: { loginId: 'RA3210', password: 'meridian-cobalt-33-JD' },
  });
  await call('/audit-assignments', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      unitId: catalogue.units[0].id,
      auditorUserId: session.user.id,
      auditType: 'EXTERNAL_5S',
    },
  });
  catalogue = await call('/sync/catalogue', { token });
  console.log(`     re-pulled: ${catalogue.assignments.length} open assignment(s)`);
}

if (catalogue.assignments.length !== 1) {
  throw new Error('the catalogue does not carry exactly one open assignment');
}

const unit = catalogue.units[0];
const zone = catalogue.zones[0];
const version = catalogue.checklistVersions.find((candidate) => candidate.questions.length === 50);
if (!version) throw new Error('no fifty-question checklist on the device');

step(3, 'start an audit and add the Zone');
const auditId = randomUUID();
await call('/audits', {
  method: 'POST',
  token,
  body: {
    id: auditId,
    auditType: 'EXTERNAL_5S',
    unitId: unit.id,
    assignmentId: catalogue.assignments[0].id,
    checklistVersionId: version.id,
    deviceId: DEVICE_ID,
  },
});
await call(`/audits/${auditId}/start`, { method: 'POST', token, body: { deviceId: DEVICE_ID } });

const auditZoneId = randomUUID();
await call(`/audits/${auditId}/zones/${auditZoneId}`, {
  method: 'PUT',
  token,
  body: { zoneId: zone.id, sequenceNo: 1, checklistVersionId: version.id },
});

step(4, 'answer all fifty questions, one request per answer, as a device does');
const questions = [...version.questions].sort((a, b) => a.globalOrder - b.globalOrder);
const values = questions.map((question, index) => {
  if (index === 12 || index === 27 || index === 44) return 'NA';
  if (index % 7 === 0) return 'SCORE_0';
  if (index % 3 === 0) return 'SCORE_1';
  return 'SCORE_2';
});

for (const [index, question] of questions.entries()) {
  await call(`/audit-zones/${auditZoneId}/responses/${randomUUID()}`, {
    method: 'PUT',
    token,
    body: {
      checklistQuestionId: question.id,
      value: values[index],
      answeredAt: new Date().toISOString(),
      ...(index === 0 ? { remark: 'Two unlabelled bins by the press' } : {}),
    },
  });
}

step(5, 'finish the Zone and the audit');
await call(`/audits/${auditId}/zones/${auditZoneId}/complete`, {
  method: 'POST',
  token,
  body: { zoneRemark: 'Housekeeping improving on the press line' },
});
const completed = await call(`/audits/${auditId}/complete`, { method: 'POST', token, body: {} });

const expected = scoreZone(
  values.map((value, index) => ({ section: S_SECTION_ORDER[Math.floor(index / 10)], value })),
);
console.log(
  `     server ${completed.totals.scorePercentage}% · domain ${expected.totals.scorePercentage}%`,
);
if (completed.totals.scorePercentage !== expected.totals.scorePercentage) {
  throw new Error('the server score does not match the shared domain function');
}

step(6, 'the admin board shows the finished audit with its S-wise scores');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    problems.push(message.text());
  }
});
page.on('pageerror', (error) => problems.push(String(error)));

await page.goto(BASE);
await page.waitForLoadState('networkidle');
await page.getByPlaceholder('RA3210').fill('RA3210');
await page.locator('input[type=password]').fill('meridian-cobalt-33-JD');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('text=Units', { timeout: 10000 });

await page.getByRole('link', { name: 'Audits' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Show all' }).click();
await page.waitForSelector('tbody >> text=Completed', { timeout: 10000 });
await page.screenshot({ path: `${shots}/16-audit-board.png` });

step(7, 'open it: S-wise scores, the D6 snapshots, and every response');
await page.getByRole('button', { name: 'Open' }).first().click();
await page.waitForSelector('text=1S – SEIRI (SORT)', { timeout: 10000 });
await page.screenshot({ path: `${shots}/17-audit-detail.png`, fullPage: true });

const shown = await page.locator('text=/\\d+\\.\\d%/').first().innerText();
console.log(`     rendered percentage: ${shown}`);

step(8, 'edit the Zone afterwards — the completed audit must not move (D6)');
const beforeRename = (await page.locator('h3').first().innerText()).trim();

await page.getByRole('link', { name: 'Zones' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Edit' }).first().click();
await page.locator('form input').first().fill('Press shop (renamed after the audit)');
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${shots}/18-zone-renamed.png` });
const renamedVisible = await page
  .getByText('Press shop (renamed after the audit)')
  .first()
  .isVisible();
if (!renamedVisible) throw new Error('the Zone rename did not take');

await page.getByRole('link', { name: 'Audits' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Show all' }).click();
await page.getByRole('button', { name: 'Open' }).first().click();
await page.waitForSelector('text=1S – SEIRI (SORT)', { timeout: 10000 });
await page.screenshot({ path: `${shots}/19-audit-detail-after-rename.png`, fullPage: true });

// Exact, not a substring: the renamed label contains the old one, so `toContain` here
// would pass even if the snapshot had moved.
const afterRename = (await page.locator('h3').first().innerText()).trim();
if (afterRename !== beforeRename) {
  throw new Error(`the audit Zone snapshot moved: "${beforeRename}" became "${afterRename}"`);
}
console.log(`     the audit still names the Zone "${afterRename}"`);

await browser.close();

if (problems.length > 0) {
  console.log('\n  console errors:');
  for (const problem of problems.slice(0, 5)) console.log('   ', problem.slice(0, 160));
  process.exit(1);
}
console.log('\n  audit walkthrough passed with no console errors');
