/**
 * CORS allow-list e2e (S1 P0-7, T013 matrix rows 1-4).
 * Boots the real AppModule, applies the production CORS path, and proves
 * listed origins are accepted with credentials while unlisted origins are
 * denied them and origin-less clients pass through.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureCors } from './../src/common/cors';

describe('CORS allow-list (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // Production-shaped config: two listed origins, fail-closed semantics.
    configureCors(app, {
      frontendUrl: 'http://localhost:3000',
      extraOrigins: 'https://admin.example.com',
      nodeEnv: 'production',
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts the frontend origin with credentials (matrix row 1)', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:3000');
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('accepts the extra-listed origin (matrix row 2)', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'https://admin.example.com');
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://admin.example.com',
    );
  });

  it('denies credential support to unlisted origins (matrix row 3)', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'https://evil.example');
    // Browsers block credentialed access without an echoed allow-origin;
    // the cors package still emits allow-credentials alone, which grants
    // nothing by itself. The absent echo is the deny signal.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves origin-less clients normally (matrix row 4)', async () => {
    const response = await request(app.getHttpServer()).get('/');
    expect(response.status).toBeLessThan(500);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
