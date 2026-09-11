import { createHash, randomUUID } from 'node:crypto';
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

/**
 * The whole of §9.4's media flow against a live API: intent → presigned PUT → commit.
 *
 * The PUT deliberately carries **no** session. A presigned URL is its own authority, and a
 * smoke script that authenticated it would be exercising a protocol the device does not
 * use — which is the class of bug these scripts exist to catch.
 */
async function captureEvidence({ token, auditId, auditZoneId, questionResponseId, kind }) {
  const bytes = TINY_JPEG;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const evidenceId = randomUUID();

  const intent = await call('/evidence/upload-intent', {
    method: 'POST',
    token,
    body: {
      id: evidenceId,
      kind,
      auditId,
      ...(auditZoneId ? { auditZoneId } : {}),
      ...(questionResponseId ? { questionResponseId } : {}),
      contentType: 'image/jpeg',
      byteSize: bytes.byteLength,
      checksumSha256: checksum,
      capturedAt: new Date().toISOString(),
      isLiveCapture: true,
    },
  });

  const uploaded = await fetch(intent.uploadUrl, {
    method: 'PUT',
    headers: { ...intent.requiredHeaders, 'content-type': 'image/jpeg' },
    body: bytes,
  });
  if (!uploaded.ok) {
    throw new Error(`presigned PUT failed: ${uploaded.status} ${await uploaded.text()}`);
  }

  await call(`/evidence/${evidenceId}/commit`, {
    method: 'POST',
    token,
    body: { checksumSha256: checksum },
  });

  return evidenceId;
}

/** A one-by-one pixel JPEG, with real magic bytes — `commit` sniffs them (§12.8). */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

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

step(3, 'start an audit — the selfie gate first, then the Zone');
const auditId = randomUUID();
const created = await call('/audits', {
  method: 'POST',
  token,
  body: {
    id: auditId,
    auditType: 'EXTERNAL_5S',
    unitId: unit.id,
    assignmentId: catalogue.assignments[0].id,
    checklistVersionId: version.id,
    deviceId: DEVICE_ID,
    // §12.9's reading, sent raw. The server computes the distance and the flag; nothing
    // the device sends about location is trusted as a conclusion.
    location: {
      latitude: 19.9975,
      longitude: 73.7898,
      accuracyM: 14,
      provider: 'FUSED',
      isMocked: false,
    },
  },
});

// §7.1: no selfie, no READY. This is the guard Phase 4 made real, and the smoke script
// checks it against a live API because it is the one gate a broken deployment would show
// as "nothing starts" with no other symptom.
if (created.status !== 'ASSIGNED') {
  throw new Error(`a new audit with no selfie should be ASSIGNED, not ${created.status}`);
}

const selfieId = await captureEvidence({
  token,
  auditId,
  kind: 'AUDITOR_SELFIE',
});
console.log(`     selfie ${selfieId.slice(0, 8)}… captured, uploaded and committed`);

const started = await call(`/audits/${auditId}/start`, {
  method: 'POST',
  token,
  body: { deviceId: DEVICE_ID },
});
if (started.selfieEvidenceId !== selfieId) {
  throw new Error('committing the selfie did not point the audit at it');
}

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

const responseIds = questions.map(() => randomUUID());
for (const [index, question] of questions.entries()) {
  await call(`/audit-zones/${auditZoneId}/responses/${responseIds[index]}`, {
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

step(5, 'attach a photograph to the first answer, through the real presigned PUT');
const photoId = await captureEvidence({
  token,
  auditId,
  auditZoneId,
  questionResponseId: responseIds[0],
  kind: 'QUESTION_EVIDENCE',
});
const photo = await call(`/evidence/${photoId}`, { token });
// E-1: question 1 was answered SCORE_0 above, so the server files it as a nonconformity —
// whatever the device might have claimed.
if (photo.classification !== 'NONCONFORMITY') {
  throw new Error(`E-1 should have derived NONCONFORMITY, got ${photo.classification}`);
}
if (photo.syncState !== 'SYNCED') {
  throw new Error(`the photograph should be SYNCED after commit, got ${photo.syncState}`);
}

// §12.6: a presigned GET, minted after the scope check, and it has to actually work —
// this is the half no unit test exercises, because it leaves the API process.
const view = await call(`/evidence/${photoId}/view-url`, { token });
const fetched = await fetch(view.url);
if (!fetched.ok) {
  throw new Error(`the presigned view URL did not resolve: ${fetched.status}`);
}
console.log(`     view URL resolves, expires in ${view.expiresIn}s`);

step(6, 'finish the Zone and the audit');
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

step(7, 'the admin board shows the finished audit with its S-wise scores');
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

step(8, 'open it: S-wise scores, the D6 snapshots, and every response');
await page.getByRole('button', { name: 'Open' }).first().click();
await page.waitForSelector('text=1S – SEIRI (SORT)', { timeout: 10000 });
await page.screenshot({ path: `${shots}/17-audit-detail.png`, fullPage: true });

const shown = await page.locator('text=/\\d+\\.\\d%/').first().innerText();
console.log(`     rendered percentage: ${shown}`);

step(9, 'edit the Zone afterwards — the completed audit must not move (D6)');
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

step(10, 'the sync dashboard shows a quarantined item with its payload');

// Push a deliberately poisoned item so the queue has something in it. §9.5's promise —
// nothing is dropped — is only worth something if a person can see what was held, and
// that is a claim about a rendered page, not about a row.
const poisoned = {
  auditZoneId,
  checklistQuestionId: questions[0].id,
  value: 'SCORE_SEVENTEEN',
  remark: 'Third rack from the door — bin unlabelled since Tuesday',
  answeredAt: new Date().toISOString(),
};

const batch = await call('/sync/batch', {
  method: 'POST',
  token,
  body: {
    batchId: randomUUID(),
    deviceId: DEVICE_ID,
    items: [
      {
        outboxId: randomUUID(),
        entityType: 'question_response',
        entityId: randomUUID(),
        operation: 'upsert',
        payload: poisoned,
      },
    ],
  },
});

if (batch.results[0].status !== 'REJECTED') {
  throw new Error(`expected the poisoned item to be REJECTED, got ${batch.results[0].status}`);
}

await page.getByRole('link', { name: 'Sync health' }).click();
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${shots}/20-sync-health.png`, fullPage: true });

await page.getByText('Payload could not be read').first().click();
await page.waitForSelector('text=What the device sent', { timeout: 10000 });
await page.screenshot({ path: `${shots}/21-conflict-payload.png`, fullPage: true });

// The auditor's own words, on the screen, in full. That is the thing §9.5 is protecting.
const payloadShown = await page.locator('pre').first().innerText();
if (!payloadShown.includes(poisoned.remark)) {
  throw new Error('the quarantined payload is not rendered in full on the dashboard');
}
console.log('     the held payload renders verbatim, remark and all');

// And the device is listed, so a stale one can be chased (§9.6).
const deviceShown = await page.getByText(DEVICE_ID).first().isVisible();
if (!deviceShown) throw new Error('the device is not listed on the sync dashboard');

await browser.close();

if (problems.length > 0) {
  console.log('\n  console errors:');
  for (const problem of problems.slice(0, 5)) console.log('   ', problem.slice(0, 160));
  process.exit(1);
}
console.log('\n  audit walkthrough passed with no console errors');
