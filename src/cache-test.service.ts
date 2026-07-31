import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { type Cache } from 'cache-manager';

@Injectable()
export class CacheTestService implements OnModuleInit {
  private readonly logger = new Logger(CacheTestService.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  async onModuleInit() {
    this.logger.log('Testing Redis cache connection...');
    try {
      // 1. Write a temporary test key
      await this.cacheManager.set('connection_test_key', 'working', 5000);

      // 2. Read it back
      const val = await this.cacheManager.get('connection_test_key');

      if (val === 'working') {
        this.logger.log('✅ Redis connection successfully verified!');
      } else {
        throw new Error('Cache read value mismatch.');
      }
    } catch (error) {
      this.logger.error('❌ Redis connection test failed!', error);
      // Optional: process.exit(1); // Crash app on failure if caching is mission-critical
    }
  }
}
