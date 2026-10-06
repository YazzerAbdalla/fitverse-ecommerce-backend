import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxStatus } from './entities/outbox-status.enum';

/**
 * This service is responsible for outbox retention cleanup.
 * It handles deletion of old terminal events (all success legs + FAILED)
 * after OUTBOX_RETENTION_DAYS.
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

    // Not during publish — separate nightly job.
    // Identifiers are quoted: the columns are camelCase ("sentAt"), and an
    // unquoted sentAt folds to sentat, which does not exist (P0-1 threw).
    // Terminal means every end-state; success legs age on broker acceptance
    // (sentAt, falling back to createdAt), FAILED ages on createdAt.
    const result = await this.dataSource.query(
      `DELETE FROM outbox_event WHERE (status IN ($1, $2, $3, $4) AND COALESCE("sentAt", "createdAt") < NOW() - INTERVAL '1 day' * $5) OR (status = $6 AND "createdAt" < NOW() - INTERVAL '1 day' * $5)`,
      [
        OutboxStatus.SENT,
        OutboxStatus.SENT_TO_MQ,
        OutboxStatus.CONSUMED,
        OutboxStatus.DELIVERED,
        retentionDays,
        OutboxStatus.FAILED,
      ],
    );
    // TypeORM returns [rows, rowCount] for DELETE (not an object with
    // .rowCount); the old fallback read undefined and always reported 0.
    const queryResult = result as [unknown[], unknown] | { rowCount?: unknown };
    const count = Array.isArray(queryResult)
      ? queryResult[1]
      : queryResult.rowCount;
    const deleted = typeof count === 'number' ? count : 0;
    this.logger.log(
      `outbox cleanup retention ${retentionDays}d deleted ${deleted}`,
    );
    return deleted;
  }
}
