import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class AppService {
  private readonly logger = new Logger('RabbitMQTest');

  constructor(
    @Inject('NOTIFICATION_SERVICE') private readonly client: ClientProxy,
  ) {}

  // This runs automatically right after modules are initialized
  async onApplicationBootstrap() {
    try {
      this.logger.log('Testing RabbitMQ connection...');

      // Forces the ClientProxy to establish a connection
      await this.client.connect();

      this.logger.log('✅ RabbitMQ connection established successfully.');
    } catch (error) {
      this.logger.error('❌ Failed to connect to RabbitMQ broker!', error);
    }
  }
  getHello(): string {
    return 'Hello World!';
  }
}
