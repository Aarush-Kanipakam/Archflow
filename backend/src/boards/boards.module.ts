import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BoardsService } from './boards.service';
import { BoardsController } from './boards.controller';
import { BoardsGateway } from './boards.gateway';
import { UsersModule } from '../users/users.module';

/**
 * BoardsModule — Groups everything related to boards.
 *
 * In NestJS, a Module is like a folder that tells the framework:
 * "These classes belong together. Here's what they need."
 *
 * - controllers: Handle HTTP requests (REST API endpoints)
 * - providers: Handle business logic + WebSocket events
 *   (both BoardsService and BoardsGateway are "providers")
 *
 * We import JwtModule because the WebSocket Gateway needs JwtService
 * to verify tokens when clients connect. The gateway can't use
 * JwtAuthGuard (that's HTTP-only), so it manually calls jwtService.verifyAsync().
 */
@Module({
  imports: [
    // The Gateway needs JwtService to authenticate WebSocket connections
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET || 'archflow-access-secret-change-in-production',
    }),
    // The Gateway needs UsersService to look up user names for cursor labels
    UsersModule,
  ],
  controllers: [BoardsController],
  providers: [BoardsService, BoardsGateway],
  exports: [BoardsService],
})
export class BoardsModule {}
