import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type {
  CommitKaizenPhotoRequest,
  CreateKaizenRequest,
  Kaizen,
  KaizenAnalysis,
  KaizenAnalysisQuery,
  KaizenDashboard,
  KaizenDashboardQuery,
  KaizenDetail,
  KaizenExport,
  KaizenFields,
  KaizenPhoto,
  KaizenPhotoUploadIntentRequest,
  KaizenPhotoUploadIntentResponse,
  KaizenRegisterQuery,
  KaizenReview,
  KaizenSustainCheck,
  ListKaizensQuery,
  Page,
  PatchKaizenRequest,
  RecordKaizenSustainCheckRequest,
  ReviewKaizenRequest,
  SubmitKaizenRequest,
} from '@audit5s/contracts';
import { kaizenFieldsSchema } from '@audit5s/contracts';
import {
  ALLOWED_IMAGE_TYPES,
  assertTransition,
  formatDate,
  kaizenAnalysis,
  kaizenDashboard,
  missingKaizenFields,
  nextSustainCheck,
  sniffImageType,
  zoneDisplayLabel,
  type ScopeContext,
} from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { scopeFor } from '../../common/auth/scope-for';
import { auditLogRow } from '../../common/audit-log/audit-log.service';
import { insertAuditLog } from '../../common/audit-log/audit-log.repository';
import { CONFIG, type AppConfig } from '../../config/env';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { asAppError } from '../audit-assignments/assignments.service';
import { REPORT_IMAGE_TIERS, fitImage, prepareImage, toDataUri } from '../reports/report-images';
import { ReportRenderer } from '../reports/report-renderer';
import { kaizenSheetFileName, renderKaizenSheetHtml } from './kaizen-sheet';
import {
  KaizensRepository,
  kaizenColumnsOf,
  type KaizenPhotoRow,
  type KaizenReviewRow,
  type KaizenRow,
  type KaizenSustainCheckRow,
} from './kaizens.repository';

const EDITABLE = new Set(['DRAFT', 'SENT_BACK']);

/** The author may change it: DRAFT or SENT_BACK, and not discarded (R-49). */
function editable(row: KaizenRow): boolean {
  return EDITABLE.has(row.status) && !row.discardedAt;
}


export interface KaizenExportJobData {
  kaizenId: string;
  exportId: string;
  /** Who asked. Identity, never authority: the worker re-reads the grant. */
  userId: string;
}
const FIELD_KEYS = Object.keys(kaizenFieldsSchema.shape) as (keyof KaizenFields)[];

/**
 * Kaizens (R-48, plans/kaizen-module.md §4.2, §4.5).
 *
 * Every method derives the scope it needs from PART 6 itself (`scopeFor`), so the HTTP
 * route and `/sync/batch` — which arrives under `sync:push` — get the same answer (AZ-5).
 *
 *   - `kaizen:create` — the author's: create, edit and submit while DRAFT or SENT_BACK.
 *     The resolver is the Unit; "author only" is checked here, and an author who is not
 *     the caller reads as absent, because a Zone Leader cannot read another's Kaizen.
 *   - `kaizen:review` — the Coordinator's: approve, send back, reject a SUBMITTED one.
 *   - `kaizen:read` — the lists, the detail, the dashboard and the analysis table.
 *
 * Each move writes its `audit_log` entry, and a review its `kaizen_review` row, on the
 * transaction that makes it: there is no approval without its record, nor a record of
 * one that did not happen.
 */
@Injectable()
export class KaizensService {
  private readonly logger = new Logger('kaizen.export');

  constructor(
    private readonly repository: KaizensRepository,
    private readonly storage: ObjectStorage,
    private readonly queue: QueueService,
    private readonly events: DomainEvents,
    private readonly renderer: ReportRenderer,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------- reads

  async list(scope: ScopeContext, query: ListKaizensQuery): Promise<Page<Kaizen>> {
    const read = scopeFor(scope, 'kaizen:read');
    const rows = await this.repository.list(read, query);
    const hasMore = query.sort !== 'saving' && rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const data = await this.withChildren(read, page, false);
    return { data, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, kaizenId: string): Promise<KaizenDetail> {
    const read = scopeFor(scope, 'kaizen:read');
    const row = await this.repository.findById(read, kaizenId);
    // A discarded draft is not there (R-49), whoever asks.
    if (!row || row.discardedAt) throw AppError.notFound('No such Kaizen');
    return this.detail(read, row);
  }

  private async detail(read: ScopeContext, row: KaizenRow): Promise<KaizenDetail> {
    const reviews = await this.repository.reviewsFor(read, [row.id]);
    const [kaizen] = await this.withChildren(read, [row], true, reviews);
    return { ...kaizen!, reviews: reviews.map(toReview) };
  }

  /**
   * For sync's parent check: is this Kaizen on the server, as the caller sees it. A
   * discarded draft is: its photo or submission still in flight is refused, not kept waiting.
   */
  async exists(scope: ScopeContext, kaizenId: string): Promise<boolean> {
    return (await this.repository.findById(scopeFor(scope, 'kaizen:read'), kaizenId)) !== null;
  }

  async dashboard(scope: ScopeContext, query: KaizenDashboardQuery): Promise<KaizenDashboard> {
    const read = scopeFor(scope, 'kaizen:read');
    const [facts, leaderIds] = await Promise.all([
      this.repository.facts(read, query.unitId),
      this.repository.kaizenLeaderIds(read, query.unitId),
    ]);
    return kaizenDashboard(facts, query.period, new Date(), leaderIds);
  }

  /**
   * `GET /kaizens/register` (R-69): the list as one worksheet for a review meeting. Streamed
   * like the checklist error report: small, and scope-checked on the request that makes it.
   */
  async register(scope: ScopeContext, query: KaizenRegisterQuery): Promise<Buffer> {
    const read = scopeFor(scope, 'kaizen:read');
    const kaizens = await this.withChildren(read, await this.repository.register(read, query), false);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Leanstack';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Kaizen register', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Kaizen no.', key: 'no', width: 14 },
      { header: 'Unit', key: 'unit', width: 20 },
      { header: 'Zone', key: 'zone', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Theme', key: 'theme', width: 40 },
      { header: 'Machine / line', key: 'machine', width: 22 },
      { header: 'Submitted by', key: 'author', width: 20 },
      { header: 'Idea by', key: 'ideaBy', width: 18 },
      { header: 'Implemented by', key: 'implementedBy', width: 18 },
      { header: 'Implemented on', key: 'implementedOn', width: 14 },
      { header: 'Submitted on', key: 'submittedOn', width: 14 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Decided on', key: 'decidedOn', width: 14 },
      { header: 'Coordinator remark', key: 'remark', width: 36 },
      { header: 'Parameters', key: 'parameters', width: 26 },
      { header: 'Wastes', key: 'wastes', width: 30 },
      { header: 'Annual saving (₹)', key: 'saving', width: 16 },
      { header: 'Cost to implement (₹)', key: 'cost', width: 18 },
      { header: 'Horizontal deployment', key: 'horizontal', width: 12 },
      { header: 'Latest sustain check', key: 'sustain', width: 26 },
    ];
    sheet.getRow(1).font = { bold: true };
    const words = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
    for (const kaizen of kaizens) {
      const check = kaizen.sustainChecks.at(-1);
      sheet.addRow({
        no: kaizen.kaizenNo,
        unit: kaizen.unitName,
        zone: zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName),
        department: kaizen.department ?? '',
        theme: kaizen.theme ?? '',
        machine: [kaizen.machine, kaizen.lineArea].filter(Boolean).join(' · '),
        author: kaizen.authorName,
        ideaBy: kaizen.ideaBy ?? '',
        implementedBy: kaizen.implementedBy ?? '',
        implementedOn: kaizen.implementedOn ? formatDate(kaizen.implementedOn) : '',
        submittedOn: kaizen.submittedAt ? formatDate(kaizen.submittedAt) : '',
        status: words(kaizen.status),
        decidedOn: kaizen.latestReview ? formatDate(kaizen.latestReview.createdAt) : '',
        remark: kaizen.latestReview?.comment ?? '',
        parameters: kaizen.parameters.map(words).join(', '),
        wastes: kaizen.wastes.map(words).join(', '),
        saving: kaizen.annualSaving,
        cost: kaizen.implementationCost,
        horizontal: kaizen.horizontalDeployment === null ? '' : kaizen.horizontalDeployment ? 'Yes' : 'No',
        sustain: check ? `${check.dayMark} days: ${check.inPlace ? 'in place' : 'not in place'}` : '',
      });
    }
    sheet.getColumn('saving').numFmt = '#,##0';
    sheet.getColumn('cost').numFmt = '#,##0';
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async analysis(scope: ScopeContext, query: KaizenAnalysisQuery): Promise<KaizenAnalysis> {
    const facts = await this.repository.facts(scopeFor(scope, 'kaizen:read'), query.unitId);
    return {
      by: query.by,
      period: query.period,
      rows: kaizenAnalysis(facts, query.by, query.period, new Date()),
    };
  }

  // -------------------------------------------------------------- the author's

  /**
   * `POST /kaizens` and `kaizen:upsert`. Idempotent on the device's id: the first copy
   * creates the DRAFT and its number, a later one updates the sheet while it is editable.
   * A copy arriving after submission that says what the sheet already says is a replay
   * and changes nothing; one that says something else is refused, never silently dropped.
   */
  async create(scope: ScopeContext, request: CreateKaizenRequest): Promise<KaizenDetail> {
    const write = scopeFor(scope, 'kaizen:create');
    const { id, zoneId, ...fields } = request;
    const existing = await this.repository.findById(write, id);

    if (existing) {
      this.assertAuthor(scope, existing);
      // An edit queued before the discard arrives after it: accepted, and changes nothing
      // (R-49), so it never dead-letters on the phone.
      if (existing.discardedAt) return this.detail(scopeFor(scope, 'kaizen:read'), existing);
      if (existing.zoneId !== zoneId) {
        throw AppError.conflict('CONFLICT', 'A Kaizen keeps the Zone it was filed under: its number carries the code');
      }
      if (!editable(existing)) {
        if (sameSheet(existing, fields)) return this.get(scope, id);
        throw this.notEditable(existing);
      }
      await this.repository.inTransaction(write, (tx) =>
        this.repository.update(tx, id, kaizenColumnsOf(fields)),
      );
      return this.get(scope, id);
    }

    try {
      await this.repository.inTransaction(write, async (tx) => {
        const zone = await this.repository.zoneForCreate(write, zoneId, tx);
        // AZ-3: a Zone outside the actor's Unit reads as absent.
        if (!zone) throw AppError.notFound('No such Zone');
        await this.repository.insert(tx, write, {
          id,
          zoneId,
          unitId: zone.unitId,
          ...kaizenColumnsOf(fields),
        });
        await insertAuditLog(
          tx,
          auditLogRow({
            action: 'kaizen.created',
            resourceType: 'kaizen',
            resourceId: id,
            unitId: zone.unitId,
            after: { zoneId },
          }),
        );
      });
    } catch (error) {
      // The id is someone else's Kaizen this actor cannot see. Said as a conflict rather
      // than a 500, and without saying whose.
      if (isUniqueViolation(error, 'kaizen_pkey')) {
        throw AppError.conflict('CONFLICT', 'A Kaizen already exists with this id');
      }
      throw error;
    }
    return this.get(scope, id);
  }

  /** `PATCH /kaizens/{id}`: the author, while DRAFT or SENT_BACK. */
  async patch(scope: ScopeContext, kaizenId: string, request: PatchKaizenRequest): Promise<KaizenDetail> {
    const write = scopeFor(scope, 'kaizen:create');
    const existing = await this.mustFindOwn(write, scope, kaizenId);
    if (!editable(existing)) throw this.notEditable(existing);
    await this.repository.inTransaction(write, (tx) =>
      this.repository.update(tx, kaizenId, kaizenColumnsOf(request)),
    );
    return this.get(scope, kaizenId);
  }

  /**
   * `POST /kaizens/{id}/submit` and `kaizen_submission:submit`. A replay of the submission
   * that put it in review returns it as it is; any other submission of a Kaizen that is not
   * a draft or sent back is a move the machine does not define.
   */
  async submit(scope: ScopeContext, kaizenId: string, request: SubmitKaizenRequest): Promise<KaizenDetail> {
    const write = scopeFor(scope, 'kaizen:create');
    await this.repository.inTransaction(write, async (tx) => {
      const current = await this.repository.findById(write, kaizenId, tx);
      if (!current || current.authorUserId !== scope.actor.userId) {
        throw AppError.notFound('No such Kaizen');
      }
      if (current.lastSubmissionId === request.submissionId) return;
      if (current.discardedAt) throw this.notEditable(current);

      // Named field by field first, so the form can mark the steps; the edge check after it
      // is then about the status alone.
      const missing = missingKaizenFields(sheetOf(current));
      if (missing.length > 0 && EDITABLE.has(current.status)) {
        throw AppError.validation(
          'Fill every required step before submitting',
          missing.map((field) => ({ field, message: 'Required' })),
        );
      }
      this.transition(scope, current.status, 'SUBMITTED', ['kaizen_sheet_complete']);

      if (!(await this.repository.submit(tx, kaizenId, request.submissionId))) {
        throw this.notEditable(current);
      }
      await insertAuditLog(
        tx,
        auditLogRow({
          action: 'kaizen.submitted',
          resourceType: 'kaizen',
          resourceId: kaizenId,
          unitId: current.unitId,
          before: { status: current.status },
          after: { status: 'SUBMITTED', submissionId: request.submissionId },
        }),
      );
      // R-69: the Unit's Coordinator hears it is waiting (0059 skips anyone without Kaizen).
      await this.events.emit(tx, {
        type: 'KAIZEN_SUBMITTED',
        actorUserId: scope.actor.userId,
        unitId: current.unitId,
        resourceType: 'kaizen',
        resourceId: kaizenId,
        data: { kaizenNo: current.kaizenNo, theme: current.theme, authorName: current.authorName, resubmitted: current.status === 'SENT_BACK' },
      });
    });
    return this.get(scope, kaizenId);
  }

  /**
   * `POST /kaizens/{id}/discard` and `kaizen:discard` (R-49): the author deletes their own
   * DRAFT. Soft: `discarded_at` takes it out of every list; the row, its number and its
   * photos stay. Discarding one already discarded is a no-op, because the phone retries.
   */
  async discard(scope: ScopeContext, kaizenId: string): Promise<void> {
    const write = scopeFor(scope, 'kaizen:create');
    await this.repository.inTransaction(write, async (tx) => {
      const current = await this.repository.findById(write, kaizenId, tx);
      if (!current || current.authorUserId !== scope.actor.userId) {
        throw AppError.notFound('No such Kaizen');
      }
      if (current.discardedAt) return;
      if (current.status !== 'DRAFT' || !(await this.repository.discard(tx, kaizenId))) {
        throw AppError.conflict(
          'INVALID_STATE_TRANSITION',
          `Kaizen ${current.kaizenNo} is ${current.status}: only a draft can be deleted`,
        );
      }
      await insertAuditLog(
        tx,
        auditLogRow({
          action: 'kaizen.discarded',
          resourceType: 'kaizen',
          resourceId: kaizenId,
          unitId: current.unitId,
          before: { status: current.status },
          after: { discarded: true },
        }),
      );
    });
  }

  // ------------------------------------------------------------ the reviewer's

  /** `POST /kaizens/{id}/review`: the review row, the move and the log, one transaction. */
  async review(scope: ScopeContext, kaizenId: string, request: ReviewKaizenRequest): Promise<KaizenDetail> {
    const review = scopeFor(scope, 'kaizen:review');
    await this.repository.inTransaction(review, async (tx) => {
      const current = await this.repository.findById(review, kaizenId, tx);
      if (!current) throw AppError.notFound('No such Kaizen');

      const comment = request.comment ?? null;
      this.transition(scope, current.status, request.decision, comment ? ['reason_given'] : []);

      const written = await this.repository.review(tx, review, kaizenId, request.decision, comment);
      // Two reviewers at once: the second waited on the row lock and found it decided.
      if (!written) throw this.notEditable(current, 'has already been reviewed');

      await insertAuditLog(
        tx,
        auditLogRow({
          action: REVIEW_ACTIONS[request.decision],
          resourceType: 'kaizen',
          resourceId: kaizenId,
          unitId: current.unitId,
          before: { status: current.status },
          after: { status: request.decision, reviewId: written.id, ...(comment ? { comment } : {}) },
        }),
      );
      // R-69: the author hears the decision, and the reason with it.
      await this.events.emit(tx, {
        type: 'KAIZEN_REVIEWED',
        actorUserId: scope.actor.userId,
        unitId: current.unitId,
        resourceType: 'kaizen',
        resourceId: kaizenId,
        userIds: [current.authorUserId],
        data: { kaizenNo: current.kaizenNo, theme: current.theme, decision: request.decision, comment },
      });
    });
    return this.get(scope, kaizenId);
  }

  /**
   * `POST /kaizens/{id}/sustain-checks` (R-69): the Coordinator records the check that is
   * due — that mark and no other, once. Not in place tells the author.
   */
  async recordSustainCheck(
    scope: ScopeContext,
    kaizenId: string,
    request: RecordKaizenSustainCheckRequest,
  ): Promise<KaizenDetail> {
    const review = scopeFor(scope, 'kaizen:review');
    await this.repository.inTransaction(review, async (tx) => {
      const current = await this.repository.findById(review, kaizenId, tx);
      if (!current) throw AppError.notFound('No such Kaizen');
      const reviews = await this.repository.reviewsFor(review, [kaizenId], tx);
      const checks = await this.repository.sustainChecksFor(review, [kaizenId], tx);
      const next = nextSustainCheck(
        approvedAtOf(reviews),
        checks.map((check) => check.dayMark),
        new Date(),
      );
      if (checks.some((check) => check.dayMark === request.dayMark)) {
        throw AppError.conflict('CONFLICT', `The ${request.dayMark}-day check of ${current.kaizenNo} is already recorded`);
      }
      if (!next?.due || next.dayMark !== request.dayMark) {
        throw AppError.conflict(
          'INVALID_STATE_TRANSITION',
          next?.due
            ? `The ${next.dayMark}-day check of ${current.kaizenNo} is the one due`
            : `No check of ${current.kaizenNo} is due now`,
        );
      }
      const note = request.note ?? null;
      const check = await this.repository.insertSustainCheck(tx, review, {
        kaizenId,
        dayMark: request.dayMark,
        inPlace: request.inPlace,
        note,
      });
      await insertAuditLog(
        tx,
        auditLogRow({
          action: 'kaizen.sustain_checked',
          resourceType: 'kaizen',
          resourceId: kaizenId,
          unitId: current.unitId,
          after: { checkId: check.id, dayMark: request.dayMark, inPlace: request.inPlace, ...(note ? { note } : {}) },
        }),
      );
      if (!request.inPlace) {
        await this.events.emit(tx, {
          type: 'KAIZEN_NOT_SUSTAINED',
          actorUserId: scope.actor.userId,
          unitId: current.unitId,
          resourceType: 'kaizen',
          resourceId: kaizenId,
          userIds: [current.authorUserId],
          data: { kaizenNo: current.kaizenNo, theme: current.theme, dayMark: request.dayMark, note },
        });
      }
    });
    return this.get(scope, kaizenId);
  }

  // ----------------------------------------------------------------- photos

  /**
   * The evidence pipeline's first half (§9.4) for a Kaizen's own photo list: a metadata
   * row and a presigned PUT. Idempotent on the photo id. The bytes never pass through here.
   */
  async createPhotoIntent(
    scope: ScopeContext,
    request: KaizenPhotoUploadIntentRequest,
  ): Promise<KaizenPhotoUploadIntentResponse> {
    const write = scopeFor(scope, 'kaizen:create');
    const kaizen = await this.mustFindOwn(write, scope, request.kaizenId);

    return this.repository.inTransaction(write, async (tx) => {
      const existing = await this.repository.findPhotoById(tx, request.id);
      if (existing) {
        if (existing.kaizenId !== kaizen.id || existing.createdByUserId !== scope.actor.userId) {
          throw AppError.conflict('CONFLICT', 'A photo already exists with this id');
        }
        return this.intentResponse(existing, true);
      }
      if (!editable(kaizen)) throw this.notEditable(kaizen);

      // One live photo per box: a new one replaces the old (soft delete, D8).
      const [live] = (await this.repository.photosFor(write, [kaizen.id], tx)).filter(
        (photo) => photo.kind === request.kind,
      );
      if (live) await this.repository.removePhoto(tx, write, live.id);

      const values = {
        id: request.id,
        kaizenId: kaizen.id,
        kind: request.kind,
        objectKey: `kaizen/${kaizen.unitId}/${kaizen.id}/${request.id}.${ALLOWED_IMAGE_TYPES[request.contentType]}`,
        contentType: request.contentType,
        byteSize: request.byteSize,
        checksumSha256: request.checksumSha256,
        capturedAt: new Date(request.capturedAt),
        isLiveCapture: request.isLiveCapture,
        createdByUserId: scope.actor.userId,
      };
      await this.repository.insertPhoto(tx, values);
      return this.intentResponse(values, false);
    });
  }

  /**
   * The second half: the object is there, its size and checksum match, and its first bytes
   * are an image. The EXIF strip runs in `worker-general`, enqueued on this transaction (R-2).
   * A commit that overtakes its PUT is `EVIDENCE_NOT_UPLOADED`, which sync treats as a wait.
   */
  async commitPhoto(
    scope: ScopeContext,
    kaizenId: string,
    photoId: string,
    request: CommitKaizenPhotoRequest,
  ): Promise<KaizenPhoto> {
    const write = scopeFor(scope, 'kaizen:create');
    const photo = await this.repository.findPhoto(write, photoId);
    if (!photo || photo.kaizenId !== kaizenId || photo.createdByUserId !== scope.actor.userId) {
      throw AppError.notFound('No such photo');
    }
    if (request.checksumSha256 !== photo.checksumSha256) {
      throw AppError.conflict('CHECKSUM_MISMATCH', 'The checksum differs from the one the upload intent declared');
    }
    if (photo.uploadedAt) return toPhoto(photo, null);

    const head = await this.storage.head(photo.objectKey);
    if (!head) {
      throw AppError.conflict(
        'EVIDENCE_NOT_UPLOADED',
        'The photo is not in storage yet. Upload it to the presigned URL, then commit.',
      );
    }
    if (head.byteSize !== Number(photo.byteSize)) {
      throw AppError.conflict('CHECKSUM_MISMATCH', `The stored photo is ${head.byteSize} bytes; the intent declared ${photo.byteSize}`);
    }
    if (head.checksumSha256 !== null && head.checksumSha256 !== photo.checksumSha256) {
      throw AppError.conflict('CHECKSUM_MISMATCH', 'The stored photo does not match the checksum recorded at capture');
    }
    const header = await this.storage.readRange(photo.objectKey, 16);
    if (!header || sniffImageType(header) === null) {
      throw AppError.badRequest('UNSUPPORTED_MEDIA_TYPE', 'Not an image', 'The uploaded bytes are not a JPEG, PNG or WebP');
    }

    const uploadedAt = new Date();
    await this.repository.commitPhoto(write, photoId, {
      uploadedAt,
      width: request.width ?? null,
      height: request.height ?? null,
    }, (tx) =>
      this.queue
        .sendInTransaction(tx, QUEUES.kaizenPhotoProcess, { photoId, userId: scope.actor.userId })
        .then(() => undefined),
    );
    return toPhoto({ ...photo, uploadedAt, width: request.width ?? null, height: request.height ?? null }, null);
  }

  /** Removes a photo from an editable Kaizen (soft delete). Removing one already gone is a no-op. */
  async removePhoto(scope: ScopeContext, kaizenId: string, photoId: string): Promise<void> {
    const write = scopeFor(scope, 'kaizen:create');
    const kaizen = await this.mustFindOwn(write, scope, kaizenId);
    const photo = await this.repository.findPhoto(write, photoId);
    if (!photo || photo.kaizenId !== kaizen.id) throw AppError.notFound('No such photo');
    if (photo.deletedAt) return;
    if (!editable(kaizen)) throw this.notEditable(kaizen);
    await this.repository.inTransaction(write, (tx) => this.repository.removePhoto(tx, write, photoId));
  }

  // ------------------------------------------------------- the export (§4.6)

  /**
   * `POST /kaizens/{id}/export`: anyone who can read the Kaizen can have its sheet. No
   * database write, so the job is sent on its own; its id is the export's id.
   */
  async requestExport(scope: ScopeContext, kaizenId: string): Promise<KaizenExport> {
    const kaizen = await this.get(scope, kaizenId);
    const exportId = randomUUID();
    const job: KaizenExportJobData = { kaizenId, exportId, userId: scope.actor.userId };
    await this.queue.send(QUEUES.kaizenExport, job, { id: exportId });
    return { exportId, status: 'QUEUED', fileName: kaizenSheetFileName(kaizen), downloadUrl: null, expiresIn: null };
  }

  /** `GET /kaizens/{id}/export/{exportId}`: READY once the file is stored, FAILED once pg-boss gives up. */
  async exportStatus(scope: ScopeContext, kaizenId: string, exportId: string): Promise<KaizenExport> {
    const kaizen = await this.get(scope, kaizenId);
    const fileName = kaizenSheetFileName(kaizen);
    const key = exportKey(kaizen.unitId, kaizenId, exportId);

    if (await this.storage.head(key)) {
      const download = await this.storage.presignGet(key, {
        expiresInSeconds: this.config.REPORT_GET_URL_TTL_SECONDS,
      });
      return { exportId, status: 'READY', fileName, downloadUrl: download.url, expiresIn: download.expiresIn };
    }
    const job = await this.queue.findJob<KaizenExportJobData>(QUEUES.kaizenExport, exportId);
    // Another Kaizen's export id reads as absent, like another Unit's Kaizen.
    if (!job || job.data.kaizenId !== kaizenId) throw AppError.notFound('No such export');
    const failed = job.state === 'failed' || job.state === 'cancelled';
    return { exportId, status: failed ? 'FAILED' : 'QUEUED', fileName, downloadUrl: null, expiresIn: null };
  }

  /** The worker's half: print the sheet and store it where `exportStatus` looks. */
  async writeExport(scope: ScopeContext, kaizenId: string, exportId: string): Promise<void> {
    const read = scopeFor(scope, 'kaizen:read');
    const kaizen = await this.get(scope, kaizenId);
    const photos = await this.repository.photosFor(read, [kaizenId]);
    const dataUri = async (kind: 'BEFORE' | 'AFTER'): Promise<string | null> => {
      const photo = photos.find((p) => p.kind === kind && p.uploadedAt);
      if (!photo) return null;
      const prepared = await prepareImage({
        slot: 'photo',
        bytes: await this.storage.get(photo.objectKey),
        contentType: photo.contentType,
      });
      return toDataUri(await fitImage(prepared, REPORT_IMAGE_TIERS[0]!));
    };
    const html = renderKaizenSheetHtml(kaizen, { before: await dataUri('BEFORE'), after: await dataUri('AFTER') });
    const pdf = await this.renderer.printToPdf(html);
    await this.storage.put(exportKey(kaizen.unitId, kaizenId, exportId), pdf, 'application/pdf');
    this.logger.log(`${kaizen.kaizenNo}: sheet exported (${pdf.byteLength} bytes)`);
  }

  // ---------------------------------------------------------------- helpers

  private async withChildren(
    read: ScopeContext,
    rows: KaizenRow[],
    withViewUrls: boolean,
    knownReviews?: KaizenReviewRow[],
  ): Promise<Kaizen[]> {
    const ids = rows.map((row) => row.id);
    const [reviews, photos, checks] = await Promise.all([
      knownReviews ?? this.repository.reviewsFor(read, ids),
      this.repository.photosFor(read, ids),
      this.repository.sustainChecksFor(read, ids),
    ]);
    const latest = new Map<string, KaizenReviewRow>();
    for (const review of reviews) latest.set(review.kaizenId, review);
    const now = new Date();

    const viewUrl = async (photo: KaizenPhotoRow | undefined) => {
      if (!photo) return null;
      if (!withViewUrls || !photo.uploadedAt) return toPhoto(photo, null);
      const download = await this.storage.presignGet(photo.objectKey, {
        expiresInSeconds: this.config.EVIDENCE_GET_URL_TTL_SECONDS,
      });
      return toPhoto(photo, download.url);
    };

    return Promise.all(
      rows.map(async (row) => {
        const mine = photos.filter((photo) => photo.kaizenId === row.id);
        const sustainChecks = checks.filter((check) => check.kaizenId === row.id);
        const approvedAt = approvedAtOf(reviews.filter((review) => review.kaizenId === row.id));
        return {
          ...toKaizen(
            row,
            latest.get(row.id) ?? null,
            await viewUrl(mine.find((photo) => photo.kind === 'BEFORE')),
            await viewUrl(mine.find((photo) => photo.kind === 'AFTER')),
          ),
          approvedAt,
          sustainChecks: sustainChecks.map(toSustainCheck),
          nextSustainCheck: nextSustainCheck(
            approvedAt,
            sustainChecks.map((check) => check.dayMark),
            now,
          ),
        };
      }),
    );
  }

  private async intentResponse(
    photo: { id: string; objectKey: string; contentType: string; byteSize: number; checksumSha256: string },
    alreadyExists: boolean,
  ): Promise<KaizenPhotoUploadIntentResponse> {
    const upload = await this.storage.presignPut(photo.objectKey, {
      expiresInSeconds: this.config.EVIDENCE_PUT_URL_TTL_SECONDS,
      contentType: photo.contentType,
      byteSize: Number(photo.byteSize),
      checksumSha256: photo.checksumSha256,
    });
    return {
      photoId: photo.id,
      objectKey: photo.objectKey,
      uploadUrl: upload.url,
      requiredHeaders: upload.requiredHeaders,
      expiresIn: upload.expiresIn,
      alreadyExists,
    };
  }

  /** The author's own Kaizen under `kaizen:create`. Anyone else's reads as absent (AZ-3). */
  private async mustFindOwn(write: ScopeContext, scope: ScopeContext, kaizenId: string): Promise<KaizenRow> {
    const row = await this.repository.findById(write, kaizenId);
    if (!row || row.authorUserId !== scope.actor.userId) throw AppError.notFound('No such Kaizen');
    return row;
  }

  private assertAuthor(scope: ScopeContext, row: KaizenRow): void {
    if (row.authorUserId !== scope.actor.userId) {
      throw AppError.conflict('CONFLICT', 'A Kaizen already exists with this id');
    }
  }

  private transition(scope: ScopeContext, from: string, to: string, satisfied: string[]): void {
    try {
      assertTransition('kaizen', from, to, {
        role: scope.actor.role,
        satisfied: satisfied as never,
      });
    } catch (error) {
      throw asAppError(error);
    }
  }

  private notEditable(row: KaizenRow, what = row.discardedAt ? 'was deleted' : `is ${row.status}`): AppError {
    return AppError.conflict('INVALID_STATE_TRANSITION', `Kaizen ${row.kaizenNo} ${what}: it cannot be changed now`);
  }
}

function exportKey(unitId: string, kaizenId: string, exportId: string): string {
  return `kaizen/${unitId}/${kaizenId}/exports/${exportId}.pdf`;
}

const REVIEW_ACTIONS = {
  APPROVED: 'kaizen.approved',
  SENT_BACK: 'kaizen.sent_back',
  REJECTED: 'kaizen.rejected',
} as const;

/** The row's sheet in request terms: money as a number, as the contract carries it. */
function sheetOf(row: KaizenRow): KaizenFields {
  const sheet = Object.fromEntries(FIELD_KEYS.map((key) => [key, row[key]])) as KaizenFields;
  return {
    ...sheet,
    annualSaving: row.annualSaving === null ? null : Number(row.annualSaving),
    implementationCost: row.implementationCost === null ? null : Number(row.implementationCost),
  };
}

/** Whether every field a copy carries already holds that value. */
function sameSheet(row: KaizenRow, fields: KaizenFields): boolean {
  const stored = kaizenColumnsOf(sheetOf(row));
  const incoming = kaizenColumnsOf(fields);
  return (Object.keys(incoming) as (keyof typeof incoming)[]).every(
    (key) => JSON.stringify(incoming[key] ?? null) === JSON.stringify(stored[key] ?? null),
  );
}

/** The APPROVED review's time; null unless approved. */
function approvedAtOf(reviews: readonly KaizenReviewRow[]): string | null {
  return reviews.find((review) => review.decision === 'APPROVED')?.createdAt.toISOString() ?? null;
}

function toSustainCheck(row: KaizenSustainCheckRow): KaizenSustainCheck {
  return {
    id: row.id,
    kaizenId: row.kaizenId,
    dayMark: row.dayMark as KaizenSustainCheck['dayMark'],
    inPlace: row.inPlace,
    note: row.note,
    checkedByName: row.checkedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toReview(row: KaizenReviewRow): KaizenReview {
  return {
    id: row.id,
    kaizenId: row.kaizenId,
    reviewerUserId: row.reviewerUserId,
    reviewerName: row.reviewerName,
    reviewerRole: row.reviewerRole,
    decision: row.decision,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPhoto(row: KaizenPhotoRow, viewUrl: string | null): KaizenPhoto {
  return {
    id: row.id,
    kaizenId: row.kaizenId,
    kind: row.kind,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: row.width,
    height: row.height,
    checksumSha256: row.checksumSha256,
    capturedAt: row.capturedAt.toISOString(),
    uploadedAt: iso(row.uploadedAt),
    isLiveCapture: row.isLiveCapture,
    viewUrl,
  };
}

function toKaizen(
  row: KaizenRow,
  latestReview: KaizenReviewRow | null,
  beforePhoto: KaizenPhoto | null,
  afterPhoto: KaizenPhoto | null,
): Omit<Kaizen, 'approvedAt' | 'sustainChecks' | 'nextSustainCheck'> {
  return {
    id: row.id,
    kaizenNo: row.kaizenNo,
    unitId: row.unitId,
    unitName: row.unitName,
    zoneId: row.zoneId,
    zoneCode: row.zoneCode,
    zoneName: row.zoneName,
    department: row.department?.trim() || null,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    machine: row.machine,
    lineArea: row.lineArea,
    implementedOn: row.implementedOn,
    teamMembers: row.teamMembers,
    theme: row.theme,
    target: row.target,
    problem5w1h: row.problem5w1h,
    rootCause4m: row.rootCause4m,
    analysis7qc: row.analysis7qc,
    countermeasure: row.countermeasure,
    wastes: row.wastes,
    parameters: row.parameters,
    horizontalDeployment: row.horizontalDeployment,
    benefits: row.benefits,
    annualSaving: row.annualSaving === null ? null : Number(row.annualSaving),
    implementationCost: row.implementationCost === null ? null : Number(row.implementationCost),
    ideaBy: row.ideaBy,
    implementedBy: row.implementedBy,
    status: row.status,
    submittedAt: iso(row.submittedAt),
    latestReview: latestReview ? toReview(latestReview) : null,
    beforePhoto,
    afterPhoto,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
