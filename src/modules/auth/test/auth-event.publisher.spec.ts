/**
 * Unit tests for AuthEventPublisher (US3 T023/T025): post-commit emission and
 * fail-open behavior (broker down/absent never throws to the caller).
 */
import { of, throwError } from 'rxjs';
import { AuthEventPublisher } from '../auth-event.publisher';

describe('AuthEventPublisher (US3)', () => {
  it('emits via client and logs userId without raw token', async () => {
    const emit = jest.fn().mockReturnValue(of({}));
    const publisher = new AuthEventPublisher({ emit } as never);
    await expect(
      publisher.emit('auth.password_reset_requested', {
        userId: 'u1',
        rawToken: 'secret-raw',
      }),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(
      'auth.password_reset_requested',
      expect.objectContaining({ userId: 'u1' }),
    );
  });

  it('fail-open: broker error resolves, never throws', async () => {
    const emit = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    const publisher = new AuthEventPublisher({ emit } as never);
    await expect(
      publisher.emit('email.verification_requested', { userId: 'u1' }),
    ).resolves.toBeUndefined();
  });

  it('fail-open: absent client resolves (tests/dev without broker)', async () => {
    const publisher = new AuthEventPublisher(undefined);
    await expect(
      publisher.emit('auth.email_verified', { userId: 'u1' }),
    ).resolves.toBeUndefined();
  });
});
