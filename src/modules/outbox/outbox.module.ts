import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxService } from './outbox.service';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxCleanupService } from './outbox-cleanup.service';
import { OutboxController } from './outbox.controller';

/**
 * This module exposes transactional outbox primitives.
 * It handles durable event buffering and async publishing to RabbitMQ.
 */
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), ConfigModule],
  controllers: [OutboxController],
  providers: [OutboxService, OutboxPublisher, OutboxCleanupService],
  exports: [OutboxService, OutboxPublisher, OutboxCleanupService],
})
export class OutboxModule {}
