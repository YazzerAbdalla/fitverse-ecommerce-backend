/**
 * P0-4 realtime auth characterization (S1 US4, T017).
 * Pins the CURRENT handleConnection outcomes with zero production change:
 * a signature-valid token whose tokenVersion was revoked still joins its
 * user room (HTTP JwtGuard would 401 it — the WS gap tracked for RP-NOTIF
 * R-4 + SEC-2c). If a later session closes the gap, THESE PINS MUST FAIL
 * and be replaced deliberately, never silently.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NotificationsGateway } from '../notifications.gateway';

describe('NotificationsGateway auth pins (P0-4, no prod change)', () => {
  const TEST_SECRET = 'ws-pin-test-secret';
  let jwtService: JwtService;

  const silentLogger = {
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;

  const mockSocket = (token?: string) => {
    const joined: string[] = [];
    let disconnected = false;
    return {
      id: 'sock-pin',
      handshake: { auth: token ? { token } : {}, query: {}, headers: {} },
      join: jest.fn((room: string) => {
        joined.push(room);
        return Promise.resolve();
      }),
      disconnect: jest.fn(() => {
        disconnected = true;
      }),
      joined,
      isDisconnected: () => disconnected,
    };
  };

  const gatewayWith = (wsAuth: string) =>
    new NotificationsGateway(jwtService, {
      get: jest.fn((key: string) =>
        key === 'WS_AUTH'
          ? wsAuth
          : key === 'JWT_SECRET'
            ? TEST_SECRET
            : undefined,
      ),
    } as unknown as ConfigService);

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jwtService = new JwtService({ secret: TEST_SECRET });
    void silentLogger;
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('revoked-version token (valid signature) still joins user room — the documented gap', async () => {
    // User's tokenVersion was bumped to 1 (logout-all/reset); this token
    // carries the stale 0. HTTP would 401; WS checks sub presence only.
    const staleToken = await jwtService.signAsync({
      sub: 'user-revoked',
      tokenVersion: 0,
    });
    const client = mockSocket(staleToken);
    await gatewayWith('true').handleConnection(client as never);
    // Current outcome: joined, NOT disconnected. RP-NOTIF R-4 may flip this.
    expect(client.joined).toEqual(['user:user-revoked']);
    expect(client.isDisconnected()).toBe(false);
  });

  it('token-less socket is disconnected', async () => {
    const client = mockSocket(undefined);
    await gatewayWith('true').handleConnection(client as never);
    expect(client.isDisconnected()).toBe(true);
    expect(client.joined).toEqual([]);
  });

  it('WS_AUTH=false joins dev-anonymous (SEC-2c current behavior, prod guard pending)', async () => {
    const client = mockSocket('any-token-ignored');
    await gatewayWith('false').handleConnection(client as never);
    expect(client.joined).toEqual(['user:dev-anonymous']);
    expect(client.isDisconnected()).toBe(false);
  });
});
