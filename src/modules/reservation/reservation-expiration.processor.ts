import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ReservationExpirationService } from './reservation-expiration.service';

/**
 * This processor is responsible for reservation expiration tick scheduling.
 * It handles BullMQ repeat registration and per-tick orchestration with Redis distributed lock.
 */
@Processor('reservation-expiration', { concurrency: 1 })
@Injectable()
export class ReservationExpirationProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ReservationExpirationProcessor.name);
  private processing = false;
  private readonly TICK_LOCK_KEY = 'expiration:tick:lock';

  constructor(
    @InjectQueue('reservation-expiration') private readonly queue: Queue,
    private readonly service: ReservationExpirationService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis?: any,
  ) {
    super();
  }

  /**
   * Tries to acquire distributed tick lock via Redis SET NX EX.
   * @returns true if lock acquired or Redis unavailable (fallback), false if another replica holds lock
   */
  private async tryAcquireTickLock(): Promise<boolean> {
    if (!this.redis) return true; // fallback to in-memory processing flag only
    const intervalMs = parseInt(
      this.configService.get<string>('EXPIRATION_INTERVAL_MS', '30000'),
      10,
    );
    // TTL = interval + 5s drift to avoid dead lock if worker crashes mid-tick
    const ttlSec =
      Math.ceil((isNaN(intervalMs) ? 30000 : intervalMs) / 1000) + 5;
    try {
      const res = await this.redis.set(
        this.TICK_LOCK_KEY,
        '1',
        'EX',
        ttlSec,
        'NX',
      );
      return res === 'OK';
    } catch {
      // Redis down — fail open, rely on in-memory flag + FOR UPDATE
      return true;
    }
  }

  async onModuleInit() {
    const enabled = this.configService.get<string>(
      'EXPIRATION_ENABLED',
      'true',
    );
    if (enabled === 'false' || enabled === '0') {
      this.logger.log(
        'reservation-expiration repeat disabled via EXPIRATION_ENABLED=false',
      );
      return;
    }
    const intervalMs = parseInt(
      this.configService.get<string>('EXPIRATION_INTERVAL_MS', '30000'),
      10,
    );
    const cron = this.configService.get<string>('EXPIRATION_CRON');
    const batchSize = this.configService.get<string>(
      'EXPIRATION_BATCH_SIZE',
      '10',
    );
    this.logger.log(
      `reservation-expiration repeat registered intervalMs=${intervalMs} cron=${cron || 'none'} batchSize=${batchSize}`,
    );
    try {
      if (cron) {
        await this.queue.add('reservation-expiration-tick', {}, {
          repeat: { pattern: cron },
          jobId: 'reservation-expiration-tick',
          removeOnComplete: true,
          removeOnFail: true,
        } as any);
      } else {
        const every = isNaN(intervalMs) ? 30000 : intervalMs;
        await this.queue.add('reservation-expiration-tick', {}, {
          repeat: { every },
          jobId: 'reservation-expiration-tick',
          removeOnComplete: true,
          removeOnFail: true,
        } as any);
      }
    } catch (e: any) {
      // jobId singleton may cause duplicate error — ignore
      this.logger.debug(`repeat registration note: ${e?.message}`);
    }
  }

  async process(job: any): Promise<any> {
    if (job.name !== 'reservation-expiration-tick') {
      this.logger.debug(`skip job ${job.name}`);
      return;
    }
    const enabled = this.configService.get<string>(
      'EXPIRATION_ENABLED',
      'true',
    );
    if (enabled === 'false' || enabled === '0') {
      this.logger.log('expiration disabled, skip tick');
      return { scanned: 0, expired: 0, skipped: 0, failed: 0, retried: 0 };
    }
    if (this.processing) {
      this.logger.debug('skip overlapping tick (previous still processing)');
      return {
        scanned: 0,
        expired: 0,
        skipped: 0,
        failed: 0,
        retried: 0,
        skippedOverlapping: true,
      };
    }
    // Distributed lock across replicas — prevents duplicate scan when multiple pods tick at same 30s window
    const locked = await this.tryAcquireTickLock();
    if (!locked) {
      this.logger.debug(
        'skip tick — another replica holds expiration:tick:lock',
      );
      return {
        scanned: 0,
        expired: 0,
        skipped: 0,
        failed: 0,
        retried: 0,
        skippedByLock: true,
      };
    }
    this.processing = true;
    try {
      const batchSize = parseInt(
        this.configService.get<string>('EXPIRATION_BATCH_SIZE', '10'),
        10,
      );
      const lim = isNaN(batchSize) ? 10 : batchSize;
      const result = await this.service.processExpiredBatch(lim);
      return result;
    } finally {
      this.processing = false;
    }
  }
}
