import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { BoardsService } from './boards.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';

/**
 * BoardsController — Defines the REST API routes for boards.
 *
 * @Controller('boards') means all routes in this class start with /boards.
 * Combined with the global prefix 'api' set in main.ts, the full URL is:
 *   http://localhost:3000/api/boards/...
 *
 * @UseGuards(JwtAuthGuard) on the class level means EVERY route in this
 * controller requires the user to be logged in. The guard checks the
 * JWT token in the Authorization header before the request reaches here.
 */
@Controller('boards')
@UseGuards(JwtAuthGuard)
export class BoardsController {
  constructor(private readonly boardsService: BoardsService) {}

  @Get()
  async getUserBoards(@GetUser('id') userId: string) {
    return this.boardsService.getUserBoards(userId);
  }

  @Post()
  async createBoard(
    @GetUser('id') userId: string,
    @Body('title') title: string,
  ) {
    // Default title if none provided
    return this.boardsService.createBoard(userId, title || 'Untitled Board');
  }

  /**
   * GET /api/boards/sandbox
   *
   * Returns the user's personal sandbox board. If one doesn't exist,
   * it gets created automatically. This is the endpoint the frontend
   * calls when you navigate to the whiteboard page.
   *
   * @GetUser('id') extracts just the 'id' field from the authenticated
   * user object that the JwtStrategy attached to the request.
   */
  @Get('sandbox')
  async getSandbox(@GetUser('id') userId: string) {
    return this.boardsService.getOrCreateSandbox(userId);
  }

  /**
   * GET /api/boards/:id
   *
   * Fetch a specific board by its UUID. The :id is a URL parameter —
   * if you visit /api/boards/abc-123, then boardId = "abc-123".
   *
   * We first verify the user has access (they must be the owner),
   * then return the full board with all its shapes.
   */
  @Get(':id')
  async getBoard(
    @Param('id') boardId: string,
    @GetUser('id') userId: string,
  ) {
    await this.boardsService.verifyAccess(boardId, userId);
    return this.boardsService.findById(boardId);
  }

  @Patch(':id')
  async updateBoard(
    @Param('id') boardId: string,
    @GetUser('id') userId: string,
    @Body('title') title: string,
  ) {
    return this.boardsService.updateBoard(boardId, userId, title);
  }

  @Delete(':id')
  async deleteBoard(
    @Param('id') boardId: string,
    @GetUser('id') userId: string,
  ) {
    return this.boardsService.deleteBoard(boardId, userId);
  }

  // =========================================================================
  // 🎓 User Roles & Sharing Endpoints
  // =========================================================================

  @Get(':id/members')
  async getMembers(
    @Param('id') boardId: string,
    @GetUser('id') userId: string,
  ) {
    return this.boardsService.getMembers(boardId, userId);
  }

  @Post(':id/members')
  async addMember(
    @Param('id') boardId: string,
    @GetUser('id') userId: string,
    @Body('email') email: string,
    @Body('role') role: 'EDITOR' | 'VIEWER',
  ) {
    return this.boardsService.addMember(boardId, userId, email, role);
  }

  @Patch(':id/members/:memberId')
  async updateMemberRole(
    @Param('id') boardId: string,
    @Param('memberId') memberId: string,
    @GetUser('id') userId: string,
    @Body('role') role: 'EDITOR' | 'VIEWER',
  ) {
    return this.boardsService.updateMemberRole(boardId, userId, memberId, role);
  }

  @Delete(':id/members/:memberId')
  async removeMember(
    @Param('id') boardId: string,
    @Param('memberId') memberId: string,
    @GetUser('id') userId: string,
  ) {
    return this.boardsService.removeMember(boardId, userId, memberId);
  }
}
