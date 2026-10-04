import User, { AuthProvider } from '../entity/user.entity';
import { UserRoles } from '../enum/roles';
import { toSafeUser } from './safe-user-response.dto';

describe('toSafeUser', () => {
  const row = {
    id: 'user-1',
    firstName: 'Alaa',
    lastName: 'Test',
    email: 'alaa@test.com',
    role: UserRoles.User,
    password: '$2b$10$hash',
    phoneNumber: null,
    phoneVerified: false,
    googleId: null,
    provider: AuthProvider.Local,
    tokenVersion: 3,
    passwordChangedAt: null,
    emailVerified: true,
    marketingOptIn: true,
    emailOptIn: false,
    // Future/folded sensitive columns must never leak even when present.
    emailVerificationTokenHash: 'ab'.repeat(32),
    emailVerificationExpiresAt: new Date(),
    emailVerificationUsedAt: null,
  } as unknown as User;

  it('exposes exactly the allow-list (incl. id/flags), never credential material', () => {
    expect(toSafeUser(row)).toEqual({
      id: 'user-1',
      firstName: 'Alaa',
      lastName: 'Test',
      email: 'alaa@test.com',
      role: UserRoles.User,
      provider: AuthProvider.Local,
      phoneNumber: null,
      phoneVerified: false,
      emailVerified: true,
      marketingOptIn: true,
      emailOptIn: false,
    });
  });

  it('never contains password, tokenVersion, googleId or verification columns', () => {
    const body = JSON.stringify(toSafeUser(row));
    expect(body).not.toContain('$2b$');
    expect(body).not.toContain('tokenVersion');
    expect(body).not.toContain('googleId');
    expect(body).not.toContain('emailVerification');
    expect(body).not.toContain('password');
  });
});
