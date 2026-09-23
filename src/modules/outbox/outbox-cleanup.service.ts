import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxStatus } from './entities/outbox-status.enum';

/**
 * This service is responsible for outbox retention cleanup.
 * It handles deletion of old SENT/FAILED events after OUTBOX_RETENTION_DAYS.
 */
@Injectable()
export class OutboxCleanupService {
  private readonly logger = new Logger(OutboxCleanupService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Deletes old terminal outbox events beyond retention.
   * @returns Count deleted.
   */
  async cleanup(): Promise<number> {
    const daysStr = this.configService.get<string>(
      'OUTBOX_RETENTION_DAYS',
      '30',
    );
    const days = parseInt(daysStr || '30', 10);
    const retentionDays = isNaN(days) ? 30 : Math.min(Math.max(days, 1), 365);

    // Not during publish — separate nightly job
    const result = await this.dataSource.query(
      `DELETE FROM outbox_event WHERE (status = $1 AND sentAt < NOW() - INTERVAL '1 day' * $2) OR (status = $2 AND createdAt < NOW() - INTERVAL '1 day' * $2)`,
      [OutboxStatus.SENT, retentionDays],
    );
    // result may be array or object depending on driver; fallback
    const count = result?.rowCount ?? 0;
    this.logger.log(
      `outbox cleanup retention ${retentionDays}d deleted ${count}`,
    );
    return count;
  }
}
