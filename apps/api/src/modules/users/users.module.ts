import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UnitsModule } from '../units/units.module';
import { ZonesModule } from '../zones/zones.module';
import { UsersController, AuditorListImportController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, UnitsModule, ZonesModule],
  controllers: [UsersController, AuditorListImportController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
