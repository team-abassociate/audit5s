import { AccessHandlePoolVFS as Pool } from 'expo-sqlite-original-pool';

// One file per person on this browser, plus a journal for each write. expo-sqlite starts with 6:
// a fifth person filled the pool and nobody could save (error 14). Tops up browsers already at 6.
// ponytail: about 31 people on one browser hits the same error; raise this if that ever happens.
const CAPACITY = 32;

/*
 * TEMPORARY diagnostic (staging, Android error 14). SQLite reports any failure to open a file as
 * error 14, and the reason goes only to this worker's console, which a phone cannot show. It goes
 * to the page instead, for `expo-executor.ts` to add to the error. Remove with the page's half.
 */
const page = new BroadcastChannel('audit5s-pool-diagnostic');
async function tell(what, vfs) {
  const slots = vfs ? `slots ${vfs.getSize()}/${vfs.getCapacity()}` : 'no pool';
  const storage = await navigator.storage.estimate().catch(() => null);
  const mb = (bytes) => Math.round((bytes ?? 0) / 1048576);
  page.postMessage(`${what}; ${slots}; storage ${mb(storage?.usage)}/${mb(storage?.quota)}MB`);
}
/** What holds the pool's files, read before the pool locks them: a count by kind, and any stray names. */
async function census(name) {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
  const kinds = {};
  let files = 0;
  for await (const [, handle] of directory.entries()) {
    files += 1;
    const head = new Uint8Array(await (await handle.getFile()).slice(0, 516).arrayBuffer());
    const path = new TextDecoder().decode(head.subarray(0, Math.max(head.indexOf(0), 0)));
    const flags = head.length === 516 ? new DataView(head.buffer).getUint32(512).toString(16) : '?';
    const kind = !path ? 'free' : path.endsWith('.db') ? 'db' : path.endsWith('-journal') ? 'journal' : `other(${path.slice(0, 12)},${flags})`;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return `at start ${files} files: ${Object.entries(kinds).map(([kind, count]) => `${kind}=${count}`).join(' ')}`;
}

const CANTOPEN = 14;
const NAMED_FILES = 0x100 | 0x800; // SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL

/** The name as it sits in memory, and the state of the views that read it (the diagnostic's question). */
function rawName(module, pointer) {
  const heap = module.HEAPU8;
  const bytes = heap.subarray(pointer, pointer + 60);
  const end = bytes.indexOf(0);
  const text = new TextDecoder().decode(bytes.subarray(0, end < 0 ? 60 : end));
  return `pointer ${pointer}, heap ${heap.length}/${heap.buffer.byteLength}, first byte ${bytes[0]}, reads "${text.slice(-20)}", UTF8ToString "${String(module.UTF8ToString(pointer)).slice(-20)}"`;
}

function reportFailedOpens(vfs) {
  const open = vfs.jOpen.bind(vfs);
  const xOpen = vfs.xOpen.bind(vfs);
  let raw = '';
  vfs.xOpen = (pVfs, zName, pFile, flags, pOutFlags) => {
    raw = rawName(vfs._module, zName);
    return xOpen(pVfs, zName, pFile, flags, pOutFlags);
  };
  vfs.jOpen = (filename, fileId, flags, outFlags) => {
    // A blank name gets a new random file from the pool: never found again and never freed, so the
    // pool fills and that work is lost. Refused, so the open fails where someone can see it.
    if (!filename && flags & NAMED_FILES) {
      void tell(`blank name refused, flags ${flags.toString(16)}: ${raw}`, vfs);
      return CANTOPEN;
    }
    const log = console.error;
    let why = 'no reason given';
    console.error = (message) => {
      why = message;
      log(message);
    };
    try {
      const result = open(filename, fileId, flags, outFlags);
      if (result !== 0) void tell(`open ${String(filename).slice(-16)}: ${why}`, vfs);
      return result;
    } finally {
      console.error = log;
    }
  };
}

/** Swapped in for expo-sqlite's pool by `metro.config.js`, on the web only. */
export class AccessHandlePoolVFS extends Pool {
  static async create(name, module) {
    let vfs;
    const held = await census(name).catch((caught) => `census failed: ${caught?.message}`);
    page.postMessage(held);
    try {
      vfs = await Pool.create(name, module);
      if (vfs.getCapacity() < CAPACITY) await vfs.addCapacity(CAPACITY - vfs.getCapacity());
    } catch (caught) {
      void tell(`pool start: ${caught?.name} ${caught?.message}`, vfs);
      throw caught;
    }
    reportFailedOpens(vfs);
    return vfs;
  }
}
