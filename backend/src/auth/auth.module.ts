import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      // We sign tokens manually in AuthService with per-call options,
      // but JwtModule still needs a default config for JwtService to be injectable.
      secret: process.env.JWT_ACCESS_SECRET || 'archflow-access-secret-change-in-production',
      signOptions: {
        expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtStrategy, PassportModule],
})
export class AuthModule {}
