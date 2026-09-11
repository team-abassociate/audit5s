import { Injectable, Logger } from '@nestjs/common';
import { Jimp } from 'jimp';
import {
  THUMBNAIL_LONG_EDGE_PX,
  grantFor,
  isAllowedImageType,
  readImageDimensions,
  sniffImageType,
  stripImageMetadata,
  thumbnailObjectKey,
  type ScopeContext,
} from '@audit5s/domain';
import { ActorRepository } from '../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { EvidenceRepository } from './evidence.repository';

export interface MediaProcessJobData {
  evidenceId: string;
  /**
   * The auditor who committed the photograph.
   *
   * Identity travels; authority does not — the rule `ChecklistImportWorker` established.
   * The role and the account's standing are re-read here, so a Consultant disabled between
   * the commit and the job does not have work done on their behalf under yesterday's
   * grant.
   *
   * It has to travel because `evidence` is behind an RLS policy keyed on `app_actor_id()`
   * and there is no system bypass by design: with no actor to become, the worker cannot
   * read the row that would tell it whose photograph this is.
   */
  auditorUserId: string;
}

/**
 * The media worker (`ARCHITECTURE.md` §5.4's `EVIDENCE_ATTACHED` consumer — "media worker
 * (thumbnail, EXIF strip)"), run by `worker-general`.
 *
 * **What it is for.** A gallery of forty photographs should not download forty full-size
 * images (PART 16: "thumbnails generated for gallery views; originals fetched only on
 * demand"), and §12.8 wants EXIF gone from what is stored. The first needs a decoder; the
 * second does not.
 *
 * **Why it is here and not in the API.** §12.8's decompression-bomb control is one line:
 * "images decoded only in the sandboxed media worker with resource limits, never in the
 * API process". A decode is the one operation in this system whose cost is set by the
 * *content* of a request rather than its size, so it happens off the request path, behind
 * a queue that can retry it, under a pixel cap read from the file's own header before a
 * bitmap is allocated.
 *
 * **The EXIF strip is defence in depth, not distrust.** `src/lib/capture/media.ts`
 * re-encodes every photograph on the device before it is even written to SQLite, which
 * drops all metadata — so in the ordinary case this worker finds nothing to remove and
 * leaves the object byte-identical. Nothing else in the system treats a device as hostile
 * and this does not either; what it does is make "EXIF is stripped" a property of what is
 * *stored* rather than a property of what the client promised. The one case where it
 * matters — a modified build, or a future import path that did not go through the capture
 * component — is exactly the case a client-side guarantee cannot cover.
 *
 * That is also why the strip is structural (`stripImageMetadata`, pure, in
 * `packages/domain`) rather than a re-encode: an object that needed no sanitising must
 * come back unchanged, and a photograph the reports print at full size (§4.1) must not be
 * recompressed for a metadata cleanup it did not need.
 */
@Injectable()
export class MediaWorker {
  private readonly logger = new Logger('media.process');

  constructor(
    private readonly repository: EvidenceRepository,
    private readonly storage: ObjectStorage,
    private readonly actors: ActorRepository,
  ) {}

  /** Registers the handler. Called by the `worker-general` entrypoint. */
  async register(queue: QueueService): Promise<void> {
    await queue.work<MediaProcessJobData>(QUEUES.mediaProcess, async (jobs) => {
      for (const job of jobs) {
        await this.handle(job.data);
      }
    });
  }

  async handle(data: MediaProcessJobData): Promise<void> {
    const scope = await this.scopeFor(data.auditorUserId);
    if (!scope) {
      // Thrown rather than swallowed, so pg-boss retries and then dead-letters it where a
      // human can see it. The photograph itself is unaffected and still viewable at full
      // size — `viewUrl` falls back to the original when there is no thumbnail — so what
      // is lost is a convenience, and saying so beats a silent gap in a gallery.
      throw new Error(
        `media.process ${data.evidenceId}: the auditor (${data.auditorUserId}) is no longer ` +
          'usable, so no thumbnail was produced. The full-size photograph is unaffected.',
      );
    }

    const row = await this.repository.findForMediaProcessing(scope, data.evidenceId);
    if (!row) {
      // Out of scope or gone. Not an error: a job can outlive the membership that made
      // its photograph readable, and retrying would never change the answer.
      this.logger.warn(`${data.evidenceId}: not readable by the committing auditor; skipped`);
      return;
    }

    if (row.mediaProcessedAt) {
      // pg-boss may deliver a job twice, and this worker rewrites an object. Idempotence
      // is a column rather than a lock: the second delivery finds the work done.
      return;
    }
    if (row.deletedAt) {
      // E-4: deleted before completion. There is nothing to build a gallery tile for.
      return;
    }
    if (row.redactedAt) {
      // R-5: the object is a placeholder now. Thumbnailing it would produce a small
      // picture of the words "photo removed", and stripping it would rewrite the very
      // object the redaction put there.
      return;
    }

    if (!isAllowedImageType(row.contentType)) {
      // §12.8's allow-list was applied at the presigned policy and again at commit; this
      // is the worker refusing to decode something it was never supposed to receive.
      throw new Error(`media.process ${row.id}: ${row.contentType} is not a permitted image type`);
    }

    const original = await this.storage.get(row.objectKey);

    // The bytes are sniffed again here rather than trusted from `commit`. Not because the
    // commit is unreliable — it is the same check — but because this is the process that
    // hands bytes to a decoder, and the check belongs immediately in front of that.
    if (sniffImageType(original) === null) {
      throw new Error(`media.process ${row.id}: the stored object is not a JPEG, PNG or WebP`);
    }

    const sanitised = await this.sanitise(row, original);
    const thumbnailKey = await this.writeThumbnail(row, sanitised.bytes);

    await this.repository.recordMediaProcessed(scope, row.id, {
      thumbnailObjectKey: thumbnailKey,
      storedChecksumSha256: sanitised.storedChecksumSha256,
    });
  }

  // ---------------------------------------------------------------------- the strip

  /**
   * §12.8's metadata rule, applied to what is actually in storage.
   *
   * Returns the bytes to thumbnail from, and a stored checksum **only** when the object
   * had to be rewritten. Null there is the normal case and means the bytes in the bucket
   * are still the bytes the device sent, which is what `commit` verifies against (R-12c).
   */
  private async sanitise(
    row: { id: string; objectKey: string; contentType: string },
    original: Buffer,
  ): Promise<{ bytes: Buffer; storedChecksumSha256: string | null }> {
    if (!isAllowedImageType(row.contentType)) {
      return { bytes: original, storedChecksumSha256: null };
    }

    const stripped = stripImageMetadata(original, row.contentType);

    if (stripped === null) {
      // The container could not be parsed. Said out loud rather than recorded as clean:
      // "this object was sanitised" is a claim, and a file this worker could not read is
      // not a file it can make that claim about. The thumbnail still gets attempted from
      // the original, because a decoder may cope with what a parser would not.
      this.logger.warn(
        `${row.id}: could not parse the ${row.contentType} container, so no metadata strip ` +
          'was attempted. The object is stored as the device sent it.',
      );
      return { bytes: original, storedChecksumSha256: null };
    }

    if (stripped.removed.length === 0) {
      return { bytes: original, storedChecksumSha256: null };
    }

    // A device that sent metadata has a modified capture path, since `processCapturedPhoto`
    // re-encodes and cannot produce any. Warned by name, because that is the finding.
    this.logger.warn(
      `${row.id}: removed ${stripped.removed.join(', ')} from the stored object — the ` +
        'capture path should already have done this (§9.4, §12.8)',
    );

    const bytes = Buffer.from(stripped.bytes);
    const written = await this.storage.put(row.objectKey, bytes, row.contentType);
    return { bytes, storedChecksumSha256: written.checksumSha256 };
  }

  // ------------------------------------------------------------------ the thumbnail

  /**
   * A ≤320 px JPEG beside the original, or null when one could not be made.
   *
   * Null rather than a throw: a thumbnail is a convenience, and a photograph whose gallery
   * tile has to be the full-size image is strictly better than a job that dead-letters
   * and a row that never records having been processed at all.
   */
  private async writeThumbnail(
    row: { id: string; objectKey: string },
    bytes: Buffer,
  ): Promise<string | null> {
    const dimensions = readImageDimensions(bytes);
    if (dimensions === null) {
      // §12.8: the pixel cap is checked from the header, so a file whose header cannot be
      // read is a file this worker will not hand to a decoder. `VP8`/`VP8L` WebPs land
      // here — their size lives inside the bitstream — and the gallery shows the original.
      this.logger.warn(`${row.id}: no readable image header, so no thumbnail was produced`);
      return null;
    }

    const pixels = dimensions.width * dimensions.height;
    if (pixels > MAX_DECODABLE_PIXELS) {
      // The decompression-bomb control, and the reason the dimensions are read from the
      // header first: this refusal costs a header read, not a bitmap allocation.
      this.logger.warn(
        `${row.id}: ${dimensions.width}×${dimensions.height} exceeds the ` +
          `${MAX_DECODABLE_PIXELS}-pixel decode cap; no thumbnail was produced (§12.8)`,
      );
      return null;
    }

    const key = thumbnailObjectKey(row.objectKey);

    try {
      const image = await Jimp.read(bytes);
      const scaled = image.scaleToFit({ w: THUMBNAIL_LONG_EDGE_PX, h: THUMBNAIL_LONG_EDGE_PX });
      // JPEG whatever the original was: a thumbnail is a gallery tile, and one format is
      // one code path in every viewer that renders it. Built from decoded pixels, so it
      // carries no metadata to strip.
      const thumbnail = await scaled.getBuffer('image/jpeg', { quality: THUMBNAIL_QUALITY });

      await this.storage.put(key, Buffer.from(thumbnail), 'image/jpeg');
      return key;
    } catch (error) {
      this.logger.warn(
        { err: error },
        `${row.id}: the thumbnail could not be encoded; the gallery will use the original`,
      );
      return null;
    }
  }

  // --------------------------------------------------------------------------- scope

  /**
   * The auditor's own scope, with the resolver PART 6 grants their role.
   *
   * `evidence:create` rather than a permission of its own, and deliberately: this work is
   * the tail of the `commit` the auditor made, finishing asynchronously. It reads and
   * writes exactly one photograph — theirs — and inventing a `media:process` permission
   * would put a grant in the matrix that no role should ever be able to exercise by hand.
   *
   * AZ-5 in practice: the path that does not go through a controller applies the same
   * checks as the one that does.
   */
  private async scopeFor(userId: string): Promise<ScopeContext | null> {
    const record = await this.actors.loadActor(userId, null);
    if (!record || !ActorRepository.isUsable(record)) return null;

    const grant = grantFor(record.actor.role, 'evidence:create');
    if (!grant) return null;

    return {
      actor: record.actor,
      resolver: grant.resolver,
      ...(grant.condition ? { condition: grant.condition } : {}),
    };
  }
}

/**
 * The decode cap (§12.8).
 *
 * 24 megapixels is a 6000 × 4000 frame — larger than any phone this app targets, and well
 * past the 1920 px long edge `processCapturedPhoto` produces. At four bytes per pixel that
 * is ~96 MB of bitmap, which one worker can hold; the next power of two cannot be assumed
 * to fit beside everything else `worker-general` is doing.
 */
const MAX_DECODABLE_PIXELS = 24_000_000;

/**
 * 72, below the capture path's 80.
 *
 * A 320 px tile is displayed at a fraction of the original's size, so the artefacts that
 * would be visible in a printed photograph are not visible here — and the tile is fetched
 * forty at a time, which is the whole reason it exists.
 */
const THUMBNAIL_QUALITY = 72;
