import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    this.logger.error(
      'Exception caught',
      exception instanceof Error ? exception.stack : '',
    );

    // Handle GraphQL requests
    if (host.getType<'graphql'>() === 'graphql') {
      const status =
        exception instanceof HttpException ? exception.getStatus() : 500;

      const message =
        exception instanceof HttpException
          ? exception.message
          : 'Internal server error';

      throw new GraphQLError(message, {
        extensions: {
          code: status,
        },
      });
    }

    // Handle REST requests
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    // Propagate RateLimit headers if present (B1 full headers: Retry-After + X-RateLimit-*)
    if (exception instanceof HttpException) {
      const opts: any = (exception as any).options;
      const headers = opts?.headers as Record<string, string> | undefined;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          try {
            response.setHeader(k, v);
          } catch {
            // ignore if response not available (e.g., GraphQL)
          }
        }
      }
      // Also support legacy cause headers
      const cause: any = (exception as any).cause;
      if (cause?.headers) {
        for (const [k, v] of Object.entries(
          cause.headers as Record<string, string>,
        )) {
          try {
            response.setHeader(k, v);
          } catch {
            // ignore
          }
        }
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
