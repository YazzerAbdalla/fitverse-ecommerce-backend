import { BadRequestException } from '@nestjs/common';
import { NotificationDispatcher } from '../notification.dispatcher';
import { NotificationChannelFactory } from '../channels/notification-channel.factory';
import { SystemChannel } from '../channels/system.channel';
import { EmailChannel } from '../channels/email.channel';

/**
 * T060 US7 dispatcher + factory unit tests (mocked UsersService prefs, no docker).
 * Covers verify/reset trust-critical override, sales gating, order operational gating, and unknown-channel 400.
 */
describe('NotificationDispatcher + NotificationChannelFactory (T060 US7)', () => {
  let dispatcher: NotificationDispatcher;
  let factory: NotificationChannelFactory;

  beforeEach(() => {
    dispatcher = new NotificationDispatcher();
    // Channels constructed without DataSource/provider (resolution only — send not called here)
    factory = new NotificationChannelFactory(
      new SystemChannel(),
      new EmailChannel(),
    );
  });

  it('verify/reset resolve both channels regardless of flags (trust-critical override)', () => {
    const optedOut = {
      marketingOptIn: false,
      emailOptIn: false,
      emailVerified: false,
    };
    expect(
      dispatcher.dispatch(
        { eventId: 'e1', type: 'verify', userId: 'u1' },
        optedOut,
      ),
    ).toEqual(['system', 'email']);
    expect(
      dispatcher.dispatch(
        { eventId: 'e2', type: 'reset', userId: 'u1' },
        optedOut,
      ),
    ).toEqual(['system', 'email']);
  });

  it('sales with full opt-in resolves both channels', () => {
    expect(
      dispatcher.dispatch(
        { eventId: 'e3', type: 'sales', userId: 'u1' },
        { marketingOptIn: true, emailOptIn: true, emailVerified: true },
      ),
    ).toEqual(['system', 'email']);
  });

  it('sales with marketingOptIn=false resolves system-only (0 email)', () => {
    expect(
      dispatcher.dispatch(
        { eventId: 'e4', type: 'sales', userId: 'u1' },
        { marketingOptIn: false, emailOptIn: true, emailVerified: true },
      ),
    ).toEqual(['system']);
  });

  it('sales with emailOptIn=false resolves system-only', () => {
    expect(
      dispatcher.dispatch(
        { eventId: 'e5', type: 'sales', userId: 'u1' },
        { marketingOptIn: true, emailOptIn: false, emailVerified: true },
      ),
    ).toEqual(['system']);
  });

  it('sales with emailVerified=false resolves system-only', () => {
    expect(
      dispatcher.dispatch(
        { eventId: 'e6', type: 'sales', userId: 'u1' },
        { marketingOptIn: true, emailOptIn: true, emailVerified: false },
      ),
    ).toEqual(['system']);
  });

  it('order.* resolves both when emailOptIn not false, system-only when false', () => {
    expect(
      dispatcher.dispatch(
        { eventId: 'e7', type: 'order.created', userId: 'u1' },
        { emailOptIn: true },
      ),
    ).toEqual(['system', 'email']);
    expect(
      dispatcher.dispatch(
        { eventId: 'e8', type: 'order.created', userId: 'u1' },
        { emailOptIn: false },
      ),
    ).toEqual(['system']);
  });

  it('factory resolves system and email strategies', () => {
    expect(factory.create('system')).toBeInstanceOf(SystemChannel);
    expect(factory.create('email')).toBeInstanceOf(EmailChannel);
    expect(factory.create('SYSTEM')).toBeInstanceOf(SystemChannel);
    expect(factory.supported()).toEqual(['system', 'email']);
  });

  it('factory throws 400 for unknown channels (sms pre-V2)', () => {
    expect(() => factory.create('sms')).toThrow(BadRequestException);
    expect(() => factory.create('push')).toThrow(BadRequestException);
  });
});
