import { AccessHandlePoolVFS as Pool } from 'expo-sqlite-original-pool';

// One file per person on this browser, plus a journal for each write. expo-sqlite starts with 6:
// a fifth person filled the pool and nobody could save (error 14). Tops up browsers already at 6.
// ponytail: about 31 people on one browser hits the same error; raise this if that ever happens.
const CAPACITY = 32;

const CANTOPEN = 14;
const NAMED_FILES = 0x100 | 0x800; // SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL

/*
 * TEMPORARY diagnostic (staging, Android error 14): what holds the pool, and any refused open, go
 * to the page for `expo-executor.ts` to add to the error. A phone cannot show this worker's console.
 * Remove once a phone has confirmed the one-at-a-time open there, keeping the refusal below.
 */
const BUILD = 'build-B';
const page = new BroadcastChannel('audit5s-pool-diagnostic');
async function census(name) {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
  const kinds = {};
  let files = 0;
  for await (const [, handle] of directory.entries()) {
    files += 1;
    const head = new Uint8Array(await (await handle.getFile()).slice(0, 512).arrayBuffer());
    const path = new TextDecoder().decode(head.subarray(0, Math.max(head.indexOf(0), 0)));
    const kind = !path ? 'free' : path.endsWith('.db') ? 'db' : path.endsWith('-journal') ? 'journal' : 'stray';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return `at start ${files} files: ${Object.entries(kinds).map(([kind, count]) => `${kind}=${count}`).join(' ')}`;
}

/**
 * A blank name gets a new random file from the pool: never found again and never freed, so the pool
 * fills and that work is lost. It means two copies of SQLite are loaded, this pool serving the other
 * one (see `openOneAtATime` in `expo-executor.ts`). Refused, so it fails where someone can see it.
 */
function refuseBlankNames(vfs) {
  const open = vfs.jOpen.bind(vfs);
  vfs.jOpen = (filename, fileId, flags, outFlags) => {
    if (!filename && flags & NAMED_FILES) {
      page.postMessage(`blank name refused, flags ${flags.toString(16)}`);
      return CANTOPEN;
    }
    return open(filename, fileId, flags, outFlags);
  };
}

/** Swapped in for expo-sqlite's pool by `metro.config.js`, on the web only. */
export class AccessHandlePoolVFS extends Pool {
  static async create(name, module) {
    page.postMessage(`${BUILD} ${await census(name).catch((caught) => `census failed: ${caught?.message}`)}`);
    const vfs = await Pool.create(name, module);
    if (vfs.getCapacity() < CAPACITY) await vfs.addCapacity(CAPACITY - vfs.getCapacity());
    refuseBlankNames(vfs);
    return vfs;
  }
}
