import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4173';
const shots = '/tmp/claude-0/shots';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  // The browser's own favicon probe is not an application error.
  if (text.includes('favicon')) return;
  problems.push(text);
});
page.on('pageerror', (e) => problems.push(String(e)));

function step(n, msg) { console.log(`  ${n}. ${msg}`); }

await page.goto(BASE);
await page.waitForLoadState('networkidle');

step(1, 'login screen renders');
await page.screenshot({ path: `${shots}/01-login.png` });
if (!(await page.getByText('5S Audit Management').isVisible())) throw new Error('no login screen');

step(2, 'sign in with the bootstrap credential (the phone number)');
await page.getByPlaceholder('RA3210').fill('RA3210');
await page.locator('input[type=password]').fill('+919876543210');
await page.getByRole('button', { name: 'Sign in' }).click();

step(3, 'forced-reset screen appears, with no way past it');
await page.waitForSelector('text=Choose a password', { timeout: 10000 });
await page.screenshot({ path: `${shots}/02-forced-reset.png` });
const navVisible = await page.getByRole('link', { name: 'Units' }).isVisible().catch(() => false);
if (navVisible) throw new Error('navigation reachable before the forced reset');

step(4, 'rotate the credential');
const pw = page.locator('input[type=password]');
await pw.nth(0).fill('+919876543210');
await pw.nth(1).fill('meridian-cobalt-33-JD');
await pw.nth(2).fill('meridian-cobalt-33-JD');
await page.getByRole('button', { name: 'Set password' }).click();

step(5, 'the application appears, with role-aware navigation');
await page.waitForSelector('text=Units', { timeout: 10000 });
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${shots}/03-units-empty.png` });

step(6, 'create a Unit');
await page.getByRole('button', { name: 'New Unit' }).click();
await page.getByPlaceholder('U-NASHIK').fill('U-NASHIK');
await page.getByPlaceholder('Nashik Plant').fill('Nashik Plant');
await page.getByRole('button', { name: 'Create Unit' }).click();
await page.waitForSelector('text=Nashik Plant', { timeout: 10000 });
await page.screenshot({ path: `${shots}/04-units-list.png` });

step(7, 'create a Consultant and read back the issued login ID');
await page.getByRole('link', { name: 'Users' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'New user' }).click();
await page.getByPlaceholder('Rahul Sharma').fill('Priya Nair');
await page.getByPlaceholder('+919876543210').fill('+919812345678');
await page.locator('select').first().selectOption('CONSULTANT');
await page.locator('select').nth(1).selectOption({ index: 1 });
await page.getByRole('button', { name: 'Create user' }).click();
await page.waitForSelector('text=PR5678', { timeout: 10000 });
await page.screenshot({ path: `${shots}/05-user-created.png` });

const notice = await page.locator('text=Their temporary password').innerText();
console.log(`     notice: ${notice.slice(0, 90)}…`);
const html = await page.content();
if (html.includes('919812345678') && !html.includes('registered phone number')) {
  throw new Error('a credential appears to be displayed');
}

step(8, 'create a Zone from the Zone 1-100 helper');
await page.getByRole('link', { name: 'Zones' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'New Zone' }).click();
// The Zone select offers Zone 1…100; the stored code is Z-01.
await page.locator('form select').first().selectOption('Z-07');
await page.getByPlaceholder('Press shop').fill('Press shop');
await page.getByPlaceholder('Trimming section').fill('Trimming section');
await page.getByRole('button', { name: 'Create Zone' }).click();
await page.waitForSelector('text=Zone 7 — Press shop', { timeout: 10000 });
await page.screenshot({ path: `${shots}/07-zones.png` });

step(9, 'import the real department workbook and review the diff');
await page.getByRole('link', { name: 'Checklists' }).click();
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Import workbook' }).click();
await page
  .locator('input[type=file]')
  .setInputFiles('../../docs/requirements/5S_lean_audit_data_1.xlsx');

// Validation runs on worker-general, so the wizard polls. Give it room.
await page.waitForSelector('text=Review the diff', { timeout: 60000 });
await page.waitForSelector('text=9 checklist sheets', { timeout: 60000 });
await page.screenshot({ path: `${shots}/08-import-preview.png` });

const errorBadge = await page.locator('text=/^0 errors$/').isVisible();
if (!errorBadge) throw new Error('the real workbook reported errors');

// `pnpm seed` imports and publishes the same nine sheets through the same pipeline, so
// whether this workbook is new depends on how the database was prepared. Both states are
// worth walking: a first import proves the wizard publishes, and a re-import proves the
// idempotence the seed claims — every sheet unchanged, nothing committable.
const firstImport = await page
  .getByRole('button', { name: '50 new' })
  .first()
  .isVisible()
  .catch(() => false);

if (firstImport) {
  step(10, 'open the side-by-side diff for one department');
  await page.getByRole('button', { name: '50 new' }).first().click();
  await page.waitForSelector('text=No published version yet', { timeout: 10000 });
  await page.screenshot({ path: `${shots}/09-import-diff.png` });

  step(11, 'commit and publish all nine');
  await page.getByRole('button', { name: /Commit and publish 9 checklists/ }).click();
  await page.waitForSelector('text=Imported and published', { timeout: 60000 });
  await page.getByRole('button', { name: 'Done' }).click();
} else {
  step(10, 'the nine are already published — the diff shows every sheet unchanged');
  await page.getByRole('button', { name: '0 changed · 0 added · 0 removed' }).first().click();
  await page.waitForSelector('text=Show all 50', { timeout: 10000 });
  await page.screenshot({ path: `${shots}/09-import-diff.png` });

  step(11, 'and nothing is committable, so the wizard offers nothing to write');
  await page.waitForSelector('text=/Nothing to import/', { timeout: 10000 });
  const commit = page.getByRole('button', { name: /^Commit and publish/ });
  if (await commit.isEnabled()) throw new Error('a no-op import offered to commit');
  await page.getByRole('button', { name: 'Close' }).click();
}

await page.waitForSelector('text=SHOP_FLOOR', { timeout: 10000 });
await page.screenshot({ path: `${shots}/10-checklists.png` });

const published = await page.locator('tbody >> text=Published').count();
console.log(`     ${published} departments published`);
if (published !== 9) throw new Error(`expected 9 published departments, saw ${published}`);

step(12, 'the published questions are visible and immutable');
await page.getByRole('button', { name: 'Premises' }).click();
await page.waitForSelector('text=1S – SEIRI (SORT)', { timeout: 10000 });
await page.screenshot({ path: `${shots}/11-checklist-questions.png` });

step(13, 'assign an audit to the Consultant');
await page.getByRole('link', { name: 'Audits' }).click();
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${shots}/13-audits-empty.png` });
await page.getByRole('button', { name: 'New assignment' }).click();
await page.locator('form select').nth(0).selectOption({ index: 1 });
await page.locator('form select').nth(1).selectOption({ index: 1 });
await page.getByRole('button', { name: 'Assign' }).click();
await page.waitForSelector('text=Open assignments', { timeout: 10000 });
await page.waitForSelector('tbody >> text=Priya Nair', { timeout: 10000 });
await page.screenshot({ path: `${shots}/14-assignment.png` });

step(14, 'the audit board is empty until a device starts one');
const boardRows = await page.locator('text=No audits are running right now.').isVisible();
if (!boardRows) throw new Error('the live board is not showing its empty state');

step(15, 'audit log shows the administrative actions');
await page.getByRole('link', { name: 'Audit log' }).click();
await page.waitForLoadState('networkidle');
await page.waitForSelector('tbody >> text=user.created', { timeout: 10000 });
await page.waitForSelector('tbody >> text=audit_assignment.created', { timeout: 10000 });
await page.screenshot({ path: `${shots}/15-audit-log.png` });
const rows = await page.locator('tbody tr').count();
console.log(`     ${rows} audit entries visible`);

await browser.close();

if (problems.length > 0) {
  console.log('\n  console errors:');
  for (const p of problems.slice(0, 5)) console.log('   ', p.slice(0, 160));
  process.exit(1);
}
console.log('\n  smoke test passed with no console errors');
