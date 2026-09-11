import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../audit-assignments/assignments.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MembershipsController } from './memberships.controller';
import { MembershipsRepository } from './memberships.repository';
import { MembershipsService } from './memberships.service';

@Module({
  imports: [AuthModule, UsersModule, AssignmentsModule],
  controllers: [MembershipsController],
  providers: [MembershipsService, MembershipsRepository],
  exports: [MembershipsService, MembershipsRepository],
})
export class MembershipsModule {}
