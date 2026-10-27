import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ZonesModule } from '../zones/zones.module';
import { UsersController, ZoneListImportController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, ZonesModule],
  controllers: [UsersController, ZoneListImportController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
