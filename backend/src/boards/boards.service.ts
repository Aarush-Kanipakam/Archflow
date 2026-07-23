import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BoardsService — The "brains" for everything board-related.
 *
 * In NestJS, a "Service" (also called a "Provider") is where you put your
 * business logic. Controllers handle HTTP routing, but Services do the
 * actual work: talking to the database, running calculations, etc.
 *
 * The @Injectable() decorator tells NestJS: "this class can be injected
 * into other classes." This is called Dependency Injection (DI).
 * Instead of manually creating `new BoardsService()`, NestJS creates
 * ONE instance and shares it everywhere it's needed.
 */
@Injectable()
export class BoardsService {
  // NestJS automatically injects PrismaService here because
  // PrismaModule is @Global() — available everywhere without importing.
  constructor(private prisma: PrismaService) {}

  /**
   * Find a board by its ID, along with all its shapes.
   *
   * The `include: { shapes: true }` tells Prisma to do a SQL JOIN —
   * it fetches the Board row AND all Shape rows that belong to it
   * in a single database query.
   */
  async findById(boardId: string) {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      include: {
        shapes: {
          orderBy: { zIndex: 'asc' }, // Draw bottom shapes first
        },
        members: true,
      },
    });

    if (!board) {
      throw new NotFoundException(`Board with ID "${boardId}" not found`);
    }

    return board;
  }

  /**
   * Fetch all boards the user has access to (owned + shared).
   * 
   * This uses a Prisma ORM OR query: give me boards where ownerId = userId
   * OR where there's a record in BoardMember matching this userId.
   */
  async getUserBoards(userId: string) {
    return this.prisma.board.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } }
        ]
      },
      orderBy: { updatedAt: 'desc' }, // Show most recently edited boards first
      include: {
        _count: {
          select: { shapes: true, members: true }
        }
      }
    });
  }

  /**
   * Create a new board with the given title.
   */
  async createBoard(userId: string, title: string) {
    return this.prisma.board.create({
      data: {
        title,
        ownerId: userId,
      },
    });
  }

  /**
   * Get or create a "sandbox" board for a user.
   *
   * This is a convenience method for Phase 2. Instead of building a
   * full board management UI, we auto-create a personal sandbox board
   * so users can immediately start drawing.
   *
   * `upsert` = "update or insert". It tries to find a matching record;
   * if it doesn't exist, it creates one. If it does, it just returns it.
   * This prevents duplicate sandbox boards for the same user.
   */
  async getOrCreateSandbox(userId: string) {
    // Look for an existing board owned by this user with the sandbox title
    const existing = await this.prisma.board.findFirst({
      where: {
        ownerId: userId,
        title: 'Sandbox',
      },
      include: {
        shapes: {
          orderBy: { zIndex: 'asc' },
        },
        members: true,
      },
    });

    if (existing) return existing;

    // No sandbox yet — create one
    return this.prisma.board.create({
      data: {
        title: 'Sandbox',
        ownerId: userId,
      },
      include: {
        shapes: {
          orderBy: { zIndex: 'asc' },
        },
        members: true,
      },
    });
  }

  /**
   * Verify that a user has access to a board.
   * This is called on GET /api/boards/:id and WebSocket board:join
   */
  async verifyAccess(boardId: string, userId: string) {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      include: { members: true },
    });

    if (!board) {
      throw new NotFoundException(`Board not found`);
    }

    // If they are the owner, access granted.
    if (board.ownerId === userId) {
      return board;
    }

    // Check if they have been explicitly invited
    const isMember = board.members.some(member => member.userId === userId);
    
    if (!isMember) {
      // 🎓 We removed the "auto-join" logic here. Now it strictly checks permissions.
      throw new ForbiddenException(`You do not have access to this board.`);
    }

    return board;
  }

  // =========================================================================
  // 🎓 User Roles & Sharing APIs
  // =========================================================================

  async getMembers(boardId: string, userId: string) {
    // Ensure the requester has access first
    await this.verifyAccess(boardId, userId);
    
    return this.prisma.boardMember.findMany({
      where: { boardId },
      include: {
        user: { select: { id: true, name: true, email: true } }
      },
      orderBy: { role: 'asc' }
    });
  }

  async addMember(boardId: string, requesterId: string, email: string, role: 'EDITOR' | 'VIEWER') {
    // Only the owner can invite people (simplification for now)
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (board?.ownerId !== requesterId) {
      throw new ForbiddenException('Only the board owner can invite members.');
    }

    // Find the user by email
    const userToInvite = await this.prisma.user.findUnique({ where: { email } });
    if (!userToInvite) {
      throw new NotFoundException('User with this email not found.');
    }

    if (userToInvite.id === requesterId) {
      throw new ForbiddenException('You cannot invite yourself.');
    }

    // Upsert the member (if they exist, update role; if not, create)
    return this.prisma.boardMember.upsert({
      where: {
        boardId_userId: { boardId, userId: userToInvite.id }
      },
      update: { role },
      create: {
        boardId,
        userId: userToInvite.id,
        role
      },
      include: {
        user: { select: { id: true, name: true, email: true } }
      }
    });
  }

  async updateMemberRole(boardId: string, requesterId: string, memberId: string, role: 'EDITOR' | 'VIEWER') {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (board?.ownerId !== requesterId) {
      throw new ForbiddenException('Only the board owner can change roles.');
    }

    return this.prisma.boardMember.update({
      where: { id: memberId },
      data: { role },
      include: {
        user: { select: { id: true, name: true, email: true } }
      }
    });
  }

  async removeMember(boardId: string, requesterId: string, memberId: string) {
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (board?.ownerId !== requesterId) {
      throw new ForbiddenException('Only the board owner can remove members.');
    }

    return this.prisma.boardMember.delete({
      where: { id: memberId }
    });
  }

  /**
   * Rename a board (Only owner can rename).
   */
  async updateBoard(boardId: string, userId: string, title: string) {
    // Ensure the user owns this board before allowing rename
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board) throw new NotFoundException('Board not found');
    if (board.ownerId !== userId) throw new ForbiddenException('Only the owner can rename the board');

    return this.prisma.board.update({
      where: { id: boardId },
      data: { title },
    });
  }

  /**
   * Delete a board (Only owner can delete).
   */
  async deleteBoard(boardId: string, userId: string) {
    // Ensure the user owns this board before allowing delete
    const board = await this.prisma.board.findUnique({ where: { id: boardId } });
    if (!board) throw new NotFoundException('Board not found');
    if (board.ownerId !== userId) throw new ForbiddenException('Only the owner can delete the board');

    return this.prisma.board.delete({
      where: { id: boardId },
    });
  }

  // ─── Shape CRUD ──────────────────────────────────────────────
  // These methods are called by the WebSocket gateway (coming next)
  // to persist shape changes to the database.

  /**
   * Create a new shape on a board.
   *
   * When a user draws a rectangle on the canvas, the frontend sends
   * the shape data here. We save it to Postgres so it persists
   * even if the user refreshes the page.
   */
  async createShape(boardId: string, data: {
    id: string;
    type: 'RECTANGLE' | 'CIRCLE' | 'TEXT' | 'ARROW' | 'LINE';
    x: number;
    y: number;
    width?: number;
    height?: number;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    text?: string;
    fontSize?: number;
    points?: number[];
    zIndex?: number;
  }) {
    return this.prisma.shape.create({
      data: {
        id: data.id,
        boardId,
        type: data.type,
        x: data.x,
        y: data.y,
        width: data.width ?? 100,
        height: data.height ?? 100,
        fill: data.fill ?? '#4A90D9',
        stroke: data.stroke ?? '#2C5F8A',
        strokeWidth: data.strokeWidth ?? 2,
        text: data.text,
        fontSize: data.fontSize ?? 16,
        points: data.points ?? [],
        zIndex: data.zIndex ?? 0,
      },
    });
  }

  /**
   * Update an existing shape's properties.
   *
   * This is called when a user moves, resizes, or recolors a shape.
   * Prisma's `update` generates a SQL UPDATE statement — it only
   * changes the fields you pass, leaving everything else untouched.
   */
  async updateShape(shapeId: string, data: Partial<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    fill: string;
    stroke: string;
    strokeWidth: number;
    text: string;
    fontSize: number;
    points: number[];
    zIndex: number;
  }>) {
    return this.prisma.shape.update({
      where: { id: shapeId },
      data,
    });
  }

  /**
   * Delete a shape from the board.
   */
  async deleteShape(shapeId: string) {
    return this.prisma.shape.delete({
      where: { id: shapeId },
    });
  }
}
