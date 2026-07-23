import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { BoardsService } from './boards.service';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

/**
 * BoardsGateway — The real-time engine of ArchFlow.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  HTTP (REST API) vs WebSockets — What's the difference?        │
 * │                                                                 │
 * │  HTTP:       Client sends request → Server sends response       │
 * │              (like sending a letter — one at a time)            │
 * │                                                                 │
 * │  WebSocket:  Client connects → both sides can send messages     │
 * │              at ANY time (like a phone call — always open)      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Socket.IO is a library built on top of WebSockets that adds:
 * - "Rooms" (groups of connected users, e.g. everyone viewing the same board)
 * - Automatic reconnection if the connection drops
 * - Fallback to HTTP polling if WebSockets aren't supported
 *
 * @WebSocketGateway() tells NestJS to start a WebSocket server.
 * The options:
 * - cors: allows the frontend (on port 3001) to connect
 * - namespace: '/boards' means the socket URL is ws://localhost:3000/boards
 */
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
    credentials: true,
  },
  namespace: '/boards',
  pingInterval: 2000, // Send a ping every 2 seconds
  pingTimeout: 4000,  // If no ping in 4 seconds, consider disconnected
})
export class BoardsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  /**
   * @WebSocketServer() gives us access to the raw Socket.IO server instance.
   * We use this to broadcast messages to all clients in a room.
   */
  @WebSocketServer()
  server!: Server;

  /**
   * ┌─────────────────────────────────────────────────────────────────┐
   * │  🎓 In-Memory State for Presence & Cursors                     │
   * │                                                                 │
   * │  We store who is currently connected directly in RAM on the     │
   * │  server (a JavaScript Map). This is FAST and doesn't need       │
   * │  a database query.                                              │
   * │                                                                 │
   * │  Trade-off: If the server restarts, this data is lost. That's   │
   * │  fine — cursor positions and "who is online" are ephemeral      │
   * │  (temporary). We don't need to save them permanently.           │
   * │                                                                 │
   * │  For a production app with multiple servers, you'd use Redis    │
   * │  as shared memory. For our single-server MVP, a Map is perfect. │
   * └─────────────────────────────────────────────────────────────────┘
   *
   * Structure: socketId → { userId, name, color, boardId }
   */
  private activeUsers = new Map<string, {
    userId: string;
    name: string;
    color: string;
    boardId: string | null;
    role: 'OWNER' | 'EDITOR' | 'VIEWER';
  }>();

  /**
   * A palette of distinguishable colors for cursors.
   * Each user gets one based on a hash of their userId.
   */
  private readonly CURSOR_COLORS = [
    '#EF4444', // red
    '#F59E0B', // amber
    '#10B981', // emerald
    '#3B82F6', // blue
    '#8B5CF6', // violet
    '#EC4899', // pink
    '#14B8A6', // teal
    '#F97316', // orange
  ];

  private getUserColor(userId: string): string {
    // Simple hash: sum the character codes and mod by palette length
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash + userId.charCodeAt(i)) % this.CURSOR_COLORS.length;
    }
    return this.CURSOR_COLORS[hash];
  }

  constructor(
    private boardsService: BoardsService,
    private jwtService: JwtService,
    private usersService: UsersService,
  ) { }

  /**
   * Called automatically when a new client connects to the WebSocket.
   *
   * This is our authentication checkpoint. Even though HTTP endpoints
   * use JwtAuthGuard, WebSockets don't have HTTP headers in the same way.
   * Instead, the frontend sends the JWT token as a "handshake" query param
   * when connecting: io('ws://...', { query: { token: '...' } })
   *
   * We verify the token here. If it's invalid, we disconnect the client.
   */
  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.query.token as string;
      if (!token) {
        client.disconnect();
        return;
      }

      // Verify the JWT token — this throws if the token is expired or forged
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET || 'archflow-access-secret-change-in-production',
      });

      /**
       * 🎓 Look up the user's name from the database.
       *
       * The JWT only contains the userId and email (to keep the token small).
       * We need the user's display name for the cursor label, so we fetch
       * it from the DB once when they connect.
       */
      const dbUser = await this.usersService.findById(payload.sub);
      const name = dbUser?.name || payload.email;

      // Attach the user info to the socket so we can use it later
      (client as any).user = { id: payload.sub, email: payload.email, name };

      // Register this socket in our presence tracker
      this.activeUsers.set(client.id, {
        userId: payload.sub,
        name,
        color: this.getUserColor(payload.sub),
        boardId: null, // Will be set when they join a board
        role: 'VIEWER', // Default until they join a board
      });
    } catch {
      // Invalid or expired token — kick them out
      client.disconnect();
    }
  }

  /**
   * Called when a client disconnects (closes browser tab, loses internet, etc.)
   *
   * 🎓 This is critical for presence. When a user closes their tab:
   * 1. We look up which board they were viewing
   * 2. We tell everyone else on that board "hey, this user left"
   * 3. We clean up our in-memory Map
   */
  handleDisconnect(client: Socket) {
    const userData = this.activeUsers.get(client.id);
    if (userData?.boardId) {
      // Broadcast to others on the same board that this user left
      client.to(userData.boardId).emit('presence:left', {
        userId: userData.userId,
        name: userData.name,
      });
    }
    this.activeUsers.delete(client.id);
  }

  // ─── Events ──────────────────────────────────────────────────
  //
  // Each @SubscribeMessage('event-name') is like a route handler,
  // but for WebSocket messages instead of HTTP requests.
  //
  // When the frontend does: socket.emit('board:join', { boardId: '...' })
  // it triggers the method decorated with @SubscribeMessage('board:join')

  /**
   * board:join — Client wants to start viewing/editing a board.
   *
   * Socket.IO "rooms" are like chat rooms. When a client joins a room,
   * any message broadcast to that room will reach them.
   *
   * Example: Users A, B, C all join room "board-abc-123".
   * When A draws a shape, we broadcast to room "board-abc-123",
   * and B and C both receive it instantly.
   */
  @SubscribeMessage('board:join')
  async handleJoinBoard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { boardId: string },
  ) {
    const user = (client as any).user;
    if (!user) return;

    // Verify the user has access to this board
    const board = await this.boardsService.verifyAccess(data.boardId, user.id);

    // Determine role
    let role: 'OWNER' | 'EDITOR' | 'VIEWER' = 'VIEWER';
    if (board.ownerId === user.id) {
      role = 'OWNER';
    } else {
      const member = board.members.find(m => m.userId === user.id);
      if (member) {
        role = member.role;
      }
    }

    // Join the Socket.IO room for this board
    client.join(data.boardId);

    // Update our presence tracker with which board this socket is viewing, and their role
    const userData = this.activeUsers.get(client.id);
    if (userData) {
      userData.boardId = data.boardId;
      userData.role = role;
    }

    /**
     * 🎓 Presence: Tell everyone else on this board that a new user joined.
     *
     * We send TWO things:
     * 1. Tell the NEW user about all the EXISTING users on the board
     *    (so their UI shows everyone who was already here)
     * 2. Tell the EXISTING users about the NEW user
     *    (so their UI adds the new avatar/cursor)
     */

    // Collect all users currently on this board (excluding the joiner)
    const usersOnBoard: { userId: string; name: string; color: string }[] = [];
    this.activeUsers.forEach((u) => {
      if (u.boardId === data.boardId && u.userId !== user.id) {
        usersOnBoard.push({ userId: u.userId, name: u.name, color: u.color });
      }
    });

    // Send the list of existing users TO the new joiner
    client.emit('presence:current', usersOnBoard);

    // Broadcast to everyone ELSE that a new user joined
    const joinerColor = userData?.color || this.getUserColor(user.id);
    client.to(data.boardId).emit('presence:joined', {
      userId: user.id,
      name: user.name,
      color: joinerColor,
    });

    return { event: 'board:joined', data: { boardId: data.boardId } };
  }

  /**
   * board:leave — Client is navigating away from the board.
   */
  @SubscribeMessage('board:leave')
  handleLeaveBoard(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { boardId: string },
  ) {
    const userData = this.activeUsers.get(client.id);
    if (userData) {
      // Tell everyone this user left
      client.to(data.boardId).emit('presence:left', {
        userId: userData.userId,
        name: userData.name,
      });
      userData.boardId = null;
    }
    client.leave(data.boardId);
  }

  // ─── Cursor Events ───────────────────────────────────────────
  /**
   * cursor:move — A user moved their mouse on the canvas.
   *
   * 🎓 WHY THROTTLING MATTERS:
   * A mouse generates 60+ move events per second. If we sent all of
   * them over the network, it would be ~3,600 messages/minute PER USER.
   *
   * The FRONTEND throttles this to ~20 events/sec before sending.
   * The backend just relays it — no database involved (cursors are ephemeral).
   *
   * Notice: NO "await" here, NO database call. This handler is synchronous
   * and blazing fast — exactly what you want for high-frequency events.
   */
  @SubscribeMessage('cursor:move')
  handleCursorMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      boardId: string;
      x: number;
      y: number;
    },
  ) {
    const userData = this.activeUsers.get(client.id);
    if (!userData) return;

    // Relay cursor position to everyone else on this board
    client.to(data.boardId).emit('cursor:moved', {
      userId: userData.userId,
      name: userData.name,
      color: userData.color,
      x: data.x,
      y: data.y,
    });
  }

  /**
   * shape:create — A user drew a new shape on the canvas.
   *
   * 1. Save the shape to the database (so it persists across page refreshes)
   * 2. Broadcast the new shape to all OTHER users viewing this board
   *
   * client.to(boardId).emit(...) sends to everyone in the room EXCEPT
   * the sender. The sender already has the shape locally — no need
   * to send it back to them.
   */
  @SubscribeMessage('shape:create')
  async handleShapeCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { boardId: string; shape: any },
  ) {
    const userData = this.activeUsers.get(client.id);
    if (userData?.role === 'VIEWER') {
      return { status: 'error', message: 'Viewers cannot create shapes' };
    }

    try {
      console.log(`[WebSocket] Received shape:create for board ${data.boardId}`);
      // Save to database
      await this.boardsService.createShape(data.boardId, data.shape);

      // Broadcast to everyone else on this board
      client.to(data.boardId).emit('shape:created', data.shape);

      // 🎓 This return value is automatically sent back to the frontend
      // as an "Acknowledgement" (ACK).
      return { status: 'ok' };
    } catch (error) {
      console.error('Failed to save shape:', error);
      return { status: 'error', message: 'Failed to save shape' };
    }
  }

  /**
   * shape:update — A user moved, resized, or changed a shape.
   *
   * This gets called frequently during dragging. We save to the DB
   * and broadcast to other users so they see the shape moving in real-time.
   */
  @SubscribeMessage('shape:update')
  async handleUpdateShape(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      boardId: string;
      shapeId: string;
      changes: any;
    },
  ) {
    const userData = this.activeUsers.get(client.id);
    if (userData?.role === 'VIEWER') {
      return { status: 'error', message: 'Viewers cannot update shapes' };
    }

    try {
      // Save to database
      await this.boardsService.updateShape(data.shapeId, data.changes);

      // Broadcast to everyone else
      client.to(data.boardId).emit('shape:updated', {
        shapeId: data.shapeId,
        changes: data.changes,
      });
      return { status: 'ok' };
    } catch (error) {
      console.error('Failed to update shape:', error);
      return { status: 'error', message: 'Failed to update shape' };
    }
  }

  /**
   * shape:delete — A user deleted a shape.
   */
  @SubscribeMessage('shape:delete')
  async handleShapeDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { boardId: string; shapeId: string },
  ) {
    const userData = this.activeUsers.get(client.id);
    if (userData?.role === 'VIEWER') {
      return { status: 'error', message: 'Viewers cannot delete shapes' };
    }

    try {
      // Remove from database
      await this.boardsService.deleteShape(data.shapeId);

      // Tell everyone else to remove it from their canvas
      client.to(data.boardId).emit('shape:deleted', {
        shapeId: data.shapeId,
      });
      return { status: 'ok' };
    } catch (error) {
      console.error('Failed to delete shape:', error);
      return { status: 'error', message: 'Failed to delete shape' };
    }
  }

  /**
   * shape:sync_all — A user performed an Undo/Redo that changed the whole state.
   */
  @SubscribeMessage('shape:sync_all')
  async handleSyncAllShapes(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      boardId: string;
      shapes: any[];
    },
  ) {
    // In a production app, you might diff the shapes here.
    // For simplicity, we just broadcast the full new state.
    // Note: We'd also need a bulk update for the database, 
    // but for this MVP, we'll rely on the auto-save debouncer 
    // (which we will implement in 6.4) to handle DB persistence.

    client.to(data.boardId).emit('shape:sync_all', data.shapes);
  }
}
