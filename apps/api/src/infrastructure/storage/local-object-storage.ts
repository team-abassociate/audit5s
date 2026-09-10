import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ObjectStorage, type StoredObject } from './object-storage';

/**
 * A filesystem adapter, used when no `R2_ENDPOINT` is configured.
 *
 * This exists for one reason: the seed imports the nine department checklists **through
 * the real import pipeline** (HANDOFF.md §5.2), and the end-to-end suites run that same
 * pipeline in CI. Neither has object-storage credentials, and neither should need a
 * running MinIO to prove that a spreadsheet parses. It is a driver behind the same port,
 * not a stub: it really stores bytes and really reads them back.
 *
 * It is not a production path. `bootstrap.sh` sets `R2_ENDPOINT`, and the startup log
 * says which driver is live so a misconfigured deployment is visible immediately.
 */
@Injectable()
export class LocalObjectStorage extends ObjectStorage {
  private readonly logger = new Logger(LocalObjectStorage.name);
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  /**
   * Keys are server-generated (§12.8: "filenames are never used"), but a path built from
   * a key is still resolved and checked rather than trusted — a traversal here would let
   * a key write outside the storage root.
   */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`Object key escapes the storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    this.logger.debug(`stored ${key} (${body.byteLength} bytes)`);
    return {
      key,
      byteSize: body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  describe(): string {
    return `file:${this.root}`;
  }
}
