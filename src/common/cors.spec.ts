import { Logger } from '@nestjs/common';
import { buildCorsAllowList, configureCors } from './cors';

describe('CORS allow-list (S1 P0-7)', () => {
  describe('buildCorsAllowList', () => {
    it('returns the frontend URL plus trimmed extras, deduplicated', () => {
      expect(
        buildCorsAllowList({
          frontendUrl: 'http://localhost:3000',
          extraOrigins: 'https://admin.example.com, ,https://admin.example.com',
        }),
      ).toEqual(['http://localhost:3000', 'https://admin.example.com']);
    });

    it('returns an empty list when nothing is configured', () => {
      expect(buildCorsAllowList({})).toEqual([]);
      expect(
        buildCorsAllowList({ frontendUrl: '  ', extraOrigins: ' ,' }),
      ).toEqual([]);
    });
  });

  describe('configureCors', () => {
    const warnSpy = jest.fn();
    const silentLogger = {
      warn: warnSpy,
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    it('accepts listed origins with credentials (matrix rows 1-2)', () => {
      const enableCors = jest.fn();
      configureCors(
        { enableCors } as never,
        {
          frontendUrl: 'http://localhost:3000',
          extraOrigins: 'https://admin.example.com',
        },
        silentLogger,
      );
      expect(enableCors).toHaveBeenCalledWith({
        origin: ['http://localhost:3000', 'https://admin.example.com'],
        credentials: true,
      });
    });

    it('fails closed in production when the list is empty', () => {
      const enableCors = jest.fn();
      configureCors(
        { enableCors } as never,
        { nodeEnv: 'production' },
        silentLogger,
      );
      // Unlisted origins get no credential support; the empty list is warned.
      expect(enableCors).toHaveBeenCalledWith({ origin: false });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('warns and preserves dev ergonomics outside production', () => {
      const enableCors = jest.fn();
      configureCors({ enableCors } as never, {}, silentLogger);
      expect(enableCors).toHaveBeenCalledWith({
        origin: true,
        credentials: true,
      });
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
