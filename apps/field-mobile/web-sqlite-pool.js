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
function reportFailedOpens(vfs) {
  const open = vfs.jOpen.bind(vfs);
  vfs.jOpen = (filename, fileId, flags, outFlags) => {
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
