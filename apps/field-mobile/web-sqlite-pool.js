import { AccessHandlePoolVFS as Pool } from 'expo-sqlite-original-pool';

// One file per person on this browser, plus a journal for each write. expo-sqlite starts with 6:
// a fifth person filled the pool and nobody could save (error 14). Tops up browsers already at 6.
// ponytail: about 31 people on one browser hits the same error; raise this if that ever happens.
const CAPACITY = 32;

/** Swapped in for expo-sqlite's pool by `metro.config.js`, on the web only. */
export class AccessHandlePoolVFS extends Pool {
  static async create(name, module) {
    const vfs = await Pool.create(name, module);
    if (vfs.getCapacity() < CAPACITY) await vfs.addCapacity(CAPACITY - vfs.getCapacity());
    return vfs;
  }
}
