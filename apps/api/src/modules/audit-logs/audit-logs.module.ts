import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsRepository } from './audit-logs.repository';

@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsRepository],
  exports: [AuditLogsRepository],
})
export class AuditLogsModule {}
