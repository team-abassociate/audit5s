// Run with Node 22.13+; validates actual migration SQL without Expo dependencies.
import { DatabaseSync } from 'node:sqlite';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/db');
const ctx = {};
for (const file of ['photo-limit.ts', 'migrations.ts']) {
  let code = stripTypeScriptTypes(readFileSync(path.join(base, file), 'utf8'));
  code = code.replace(/^import .*;\n/gm, '').replace(/export /g, '');
  runInNewContext(code, ctx);
}
const migrations = runInNewContext('LOCAL_MIGRATIONS', ctx);
const db = new DatabaseSync(':memory:');
for (const m of migrations.filter(m => m.version < 5)) for (const sql of m.statements) db.exec(sql);
const add = db.prepare(`INSERT INTO evidence (id,kind,audit_id,audit_zone_id,question_response_id,checksum_sha256,captured_at,client_updated_at) VALUES (?,?,?,?,?,'hash','now','now')`);
// Upgrade preserves pre-existing over-limit work.
for (let i=0;i<26;i++) add.run('legacy'+i,'QUESTION_EVIDENCE','a','legacy','q'+i);
for (const sql of migrations.find(m => m.version === 5).statements) db.exec(sql);
assert.equal(db.prepare("SELECT count(*) n FROM evidence WHERE audit_zone_id='legacy'").get().n,26);
assert.throws(()=>add.run('legacy27','QUESTION_EVIDENCE','a','legacy','q27'),/25-photo/);
for(let i=0;i<25;i++) add.run('p'+i,'QUESTION_EVIDENCE','a','zone','q'+i);
assert.throws(()=>add.run('p26','QUESTION_EVIDENCE','a','zone','q50'),/25-photo/);
assert.throws(()=>add.run('w26','WALK_BY_PHOTO','a','zone',null),/25-photo/);
add.run('other','QUESTION_EVIDENCE','a','other-zone','q50');
add.run('selfie','AUDITOR_SELFIE','a','zone',null);
add.run('after','CORRECTIVE_AFTER','a','zone',null);
db.exec("UPDATE evidence SET sync_state='SYNCED' WHERE id='p0'");
assert.throws(()=>add.run('synced26','QUESTION_EVIDENCE','a','zone','q50'),/25-photo/);
db.exec("UPDATE evidence SET deleted_at='now' WHERE id='p0'");
add.run('replacement','QUESTION_EVIDENCE','a','zone','q50');
assert.throws(()=>add.run('replacement26','QUESTION_EVIDENCE','a','zone','q50'),/25-photo/);
db.close();
process.stdout.write('PASS: 25 allowed; 26th blocked across questions/kinds; separate Zones; deletion/replacement; synced count; selfie/after exclusions; upgrade preserves existing photos.\n');
