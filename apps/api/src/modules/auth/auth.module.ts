import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordService],
  exports: [AuthService, PasswordService, AuthRepository],
})
export class AuthModule {}
