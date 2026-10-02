import { Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

/**
 * This gateway is responsible for realtime SYSTEM notification delivery.
 * It handles JWT-authenticated sockets in the notifications namespace and emits per-user events.
 * Offline users miss the emit by design — GET /notifications history fetch is the fallback (PG truth).
 */
@WebSocketGateway({ namespace: 'notifications', cors: true })
export class NotificationsGateway {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /**
   * Authenticates a socket via Bearer token and joins the per-user room.
   * @param client - Incoming socket connection.
   * @returns Void — disconnects unauthenticated sockets.
   */
  async handleConnection(client: Socket): Promise<void> {
    // Token may arrive via handshake auth, query, or Authorization header (browser vs non-browser).
    const auth = (client.handshake as any)?.auth ?? {};
    const query = (client.handshake as any)?.query ?? {};
    const headerToken = String(
      (client.handshake as any)?.headers?.authorization ?? '',
    ).replace(/^Bearer\s+/i, '');
    const raw: string =
      auth.token ?? query.token ?? (headerToken || undefined) ?? '';
    if (!raw) {
      this.logger.warn(`ws reject no token socket=${client.id}`);
      client.disconnect(true);
      return;
    }
    try {
      // WS_AUTH flag allows disabling auth in local dev; prod always verifies.
      const wsAuth = this.configService?.get<string>('WS_AUTH') ?? 'true';
      if (wsAuth === 'false' || wsAuth === '0') {
        this.logger.warn(`ws auth disabled, allowing socket=${client.id}`);
        await this.joinUserRoom(client, 'dev-anonymous');
        return;
      }
      const payload: any = await this.jwtService.verifyAsync(raw, {
        secret: this.configService?.get<string>('JWT_SECRET'),
      });
      const sub = payload?.sub;
      if (!sub) {
        throw new Error('missing sub');
      }
      // TokenVersion revocation is enforced on HTTP via JwtStrategy; WS checks sub presence only (documented gap).
      await this.joinUserRoom(client, String(sub));
    } catch (e: any) {
      this.logger.warn(
        `ws reject invalid token socket=${client.id}: ${e?.message}`,
      );
      client.disconnect(true);
    }
  }

  /**
   * Joins a socket to its per-user room for targeted emits.
   * @param client - Authenticated socket.
   * @param userId - JWT subject to scope the room.
   * @returns Void.
   */
  private async joinUserRoom(client: Socket, userId: string): Promise<void> {
    // Room naming user:<sub> keeps broadcasts scoped to one inbox.
    await client.join(`user:${userId}`);
    this.logger.log(`ws connected socket=${client.id} room=user:${userId}`);
  }

  /**
   * Broadcasts a notification payload to one user's room.
   * @param userId - Recipient user id (room user:<userId>).
   * @param payload - Notification DTO {id, type, title, body, channel, eventId, createdAt}.
   * @returns Void — no-op when server not yet bound (unit tests).
   */
  broadcastToUser(userId: string, payload: Record<string, unknown>): void {
    // Fail-open when gateway not bound (unit tests instantiate without server).
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit('notification:new', payload);
    this.logger.log(
      `ws emit notification:new userId=${userId} eventId=${String((payload as any)?.eventId ?? 'unknown')}`,
    );
  }

  /**
   * Echoes a client read acknowledgement (post-commit read state lives in PG).
   * @param data - Client payload {notificationId}.
   * @param client - Sending socket.
   * @returns Echo acknowledgement {received:true}.
   */
  @SubscribeMessage('notification:read')
  handleRead(
    @MessageBody() data: { notificationId?: string },
    @ConnectedSocket() client: Socket,
  ): { received: boolean; notificationId?: string } {
    // Read state is committed via PATCH :id/read HTTP; WS only echoes (no PG write here).
    this.logger.debug(
      `ws notification:read socket=${client.id} notificationId=${data?.notificationId ?? 'unknown'}`,
    );
    return { received: true, notificationId: data?.notificationId };
  }
}
