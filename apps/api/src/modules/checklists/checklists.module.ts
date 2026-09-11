import { Module } from '@nestjs/common';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsRepository } from './checklists.repository';
import { ChecklistsService } from './checklists.service';
import { ChecklistImportController } from './import/checklist-import.controller';
import { ChecklistImportRepository } from './import/checklist-import.repository';
import { ChecklistImportService } from './import/checklist-import.service';
import { ChecklistImportWorker } from './import/checklist-import.worker';
import { ChecklistErrorReportWriter } from './import/error-report.writer';
import { WorkbookReader } from './import/workbook-reader';

@Module({
  controllers: [ChecklistsController, ChecklistImportController],
  providers: [
    ChecklistsService,
    ChecklistsRepository,
    ChecklistImportService,
    ChecklistImportRepository,
    ChecklistImportWorker,
    ChecklistErrorReportWriter,
    WorkbookReader,
  ],
  exports: [ChecklistsService, ChecklistsRepository, ChecklistImportService, ChecklistImportWorker],
})
export class ChecklistsModule {}
