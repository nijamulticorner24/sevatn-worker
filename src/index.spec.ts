import { bootstrap } from './index';
import { SanitizedLogger } from './monitoring/logger';

describe('Worker Boot Configuration Suite (PR #5)', () => {
  it('logs resolved AVAILABILITY_POLL_INTERVAL_MS at boot', async () => {
    // Boot log shows 5000ms because the test sets it; production default is 8000ms (see .env.example).
    process.env.AVAILABILITY_POLL_INTERVAL_MS = '5000';
    const logSpy = jest.spyOn(SanitizedLogger, 'info');
    await bootstrap();

    const configLog = logSpy.mock.calls.find((call) =>
      String(call[0]).includes('[CONFIG] AVAILABILITY_POLL_INTERVAL_MS=5000')
    );
    expect(configLog).toBeDefined();

    delete process.env.AVAILABILITY_POLL_INTERVAL_MS;
    logSpy.mockRestore();
  });
});
