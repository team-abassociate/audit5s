import { AccessHandlePoolVFS as Pool } from 'expo-sqlite-original-pool';

// One file per person on this browser, plus a journal for each write. expo-sqlite starts with 6:
// a fifth person filled the pool and nobody could save (error 14). Tops up browsers already at 6.
// ponytail: about 31 people on one browser hits the same error; raise this if that ever happens.
const CAPACITY = 32;

const CANTOPEN = 14;
const NAMED_FILES = 0x100 | 0x800; // SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL

/** Swapped in for expo-sqlite's pool by `metro.config.js`, on the web only. */
export class AccessHandlePoolVFS extends Pool {
  static async create(name, module) {
    const vfs = await Pool.create(name, module);
    if (vfs.getCapacity() < CAPACITY) await vfs.addCapacity(CAPACITY - vfs.getCapacity());
    /*
     * A blank name gets a new random file from the pool: never found again and never freed, so the
     * pool fills and that work is lost. It means two copies of SQLite are loaded, this pool serving
     * the other one (see `openOneAtATime` in `expo-executor.ts`). Refused, so the failure shows.
     */
    const open = vfs.jOpen.bind(vfs);
    vfs.jOpen = (filename, fileId, flags, outFlags) =>
      !filename && flags & NAMED_FILES ? CANTOPEN : open(filename, fileId, flags, outFlags);
    return vfs;
  }
}
