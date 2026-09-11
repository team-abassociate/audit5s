import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsRepository } from './permissions.repository';

@Module({
  controllers: [PermissionsController],
  providers: [PermissionsRepository],
  exports: [PermissionsRepository],
})
export class PermissionsModule {}
