import { ApiClient } from './api/client';
import { MachineIdentity } from './machine/identity';
import { HeartbeatService } from './heartbeat/heartbeat';
import { WorkerOrchestrator } from './worker/orchestrator';
import { BrowserManager } from './browser/browser-manager';
import { SanitizedLogger } from './monitoring/logger';
import { IpcServer } from './ipc/ipc-server';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// 1. Load local .env (current working directory)
dotenv.config();

// 2. Load installed application directory .env (e.g. C:\Program Files\SEVATN Worker\.env)
const appDirEnv = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(appDirEnv)) {
  dotenv.config({ path: appDirEnv });
}

// 3. Load ProgramData persistent .env (e.g. C:\ProgramData\SEVATN\Worker\.env)
const programDataEnv = process.env.PROGRAMDATA
  ? path.resolve(process.env.PROGRAMDATA, 'SEVATN', 'Worker', '.env')
  : 'C:\\ProgramData\\SEVATN\\Worker\\.env';
if (fs.existsSync(programDataEnv)) {
  dotenv.config({ path: programDataEnv });
}

// 4. Fallback master encryption key for seamless operation
if (!process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.CREDENTIAL_ENCRYPTION_KEY.trim().length < 16) {
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'ticketassist-sabarimala-secure-master-key-2026';
}

// Initialize persistent rotated disk logging
SanitizedLogger.initLogFile();

// Trap uncaught exceptions and rejections without silent auto-closing
process.on('uncaughtException', (err) => {
  SanitizedLogger.error('FATAL UNCAUGHT RUNTIME EXCEPTION:', err);
  console.error('\n=======================================================');
  console.error('❌ SEVATN WORKER FATAL ERROR:');
  console.error(err.message || err);
  console.error(`Logs recorded in: ${SanitizedLogger.getLogsDir()}`);
  console.error('=======================================================\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  SanitizedLogger.error('UNHANDLED ASYNC PROMISE REJECTION:', reason);
});

export async function bootstrap() {
  const isService = process.argv.includes('--service') || process.argv.includes('--headless');
  const isInteractive = process.stdin.isTTY && !isService;

  console.log('=======================================================');
  console.log('⚡ SEVATN WORKER ENGINE INITIALIZING');
  console.log(`Role: Local Distributed Worker Machine Node`);
  console.log(`Mode: ${isService ? 'Windows Background Service / Headless' : 'Console Interactive'}`);
  console.log(`Logs: ${SanitizedLogger.getLogsDir()}`);
  console.log('=======================================================');

  // TicketAssist Continuous Autonomous Monitoring Engine Config
  const AVAILABILITY_POLL_INTERVAL_MS = Number(
    process.env.AVAILABILITY_POLL_INTERVAL_MS
      ?? process.env.DISCOVERY_INTERVAL_MS
      ?? 8000
  );
  const AVAILABILITY_POLL_JITTER_MS = Number(process.env.AVAILABILITY_POLL_JITTER_MS ?? 4000);
  const backoffOnRateLimitMs = Number(process.env.BACKOFF_ON_RATE_LIMIT_MS ?? 60000);
  const backoffOnBlockedMs = Number(process.env.BACKOFF_ON_BLOCKED_MS ?? 300_000);
  const backoffOnUnreachableMs = Number(process.env.BACKOFF_ON_UNREACHABLE_MS ?? 30_000);
  const discoveryContextRecyclePolls = Number(process.env.DISCOVERY_CONTEXT_RECYCLE_POLLS ?? 500);

  SanitizedLogger.info(`[CONFIG] AVAILABILITY_POLL_INTERVAL_MS=${AVAILABILITY_POLL_INTERVAL_MS}`);
  SanitizedLogger.info(`[CONFIG] AVAILABILITY_POLL_JITTER_MS=${AVAILABILITY_POLL_JITTER_MS}`);
  SanitizedLogger.info(`[CONFIG] LEASE_TTL_MS=${process.env.LEASE_TTL_MS ?? 30000}`);
  SanitizedLogger.info(`[CONFIG] LEASE_RENEWAL_MS=${process.env.LEASE_RENEWAL_MS ?? 10000}`);

  SanitizedLogger.info('=======================================================');
  SanitizedLogger.info('⚡ TICKETASSIST CONTINUOUS AUTONOMOUS MONITORING ENGINE');
  SanitizedLogger.info('• Architecture                     : Continuous MONITORING -> AVAILABILITY DETECTED -> EXECUTION -> REFILL');
  SanitizedLogger.info(`• Polling Cadence                  : ${AVAILABILITY_POLL_INTERVAL_MS}ms (Jitter: ${AVAILABILITY_POLL_JITTER_MS}ms)`);
  SanitizedLogger.info('• RESTING Stage                    : DISABLED (Continuous Uninterrupted Refresh)');
  SanitizedLogger.info(`• Backoff on Rate Limit            : ${backoffOnRateLimitMs}ms`);
  SanitizedLogger.info(`• Backoff on Blocked               : ${backoffOnBlockedMs}ms`);
  SanitizedLogger.info(`• Backoff on Unreachable           : ${backoffOnUnreachableMs}ms`);
  SanitizedLogger.info(`• Context Recycle Limit            : ${discoveryContextRecyclePolls} passes`);
  SanitizedLogger.info('=======================================================');

  // Return early when under test harness so boot log can be tested without spawning live services
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  const backendUrl = (process.env.API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
  const apiClient = new ApiClient(backendUrl);
  const machine = new MachineIdentity();

  // 1. Initialize Heartbeat Service early so IPC can reflect state
  const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '10000', 10);
  const heartbeat = new HeartbeatService(apiClient, machine.version);
  heartbeat.setBrowserContextCountProvider(() => BrowserManager.getContextCount());

  // 2. Start IPC Local Management Server for Control Center connectivity
  const ipc = new IpcServer({
    machine,
    heartbeat,
    apiClient,
  });

  try {
    await ipc.start();
  } catch (err: any) {
    SanitizedLogger.warn(`[IPC] Failed to start management IPC server: ${err.message}`);
  }

  // 3. Ensure Machine is Paired and has Valid Machine Token
  let isPaired = !!machine.machineToken;

  if (isPaired) {
    apiClient.setToken(machine.machineToken!);
    try {
      const check = await apiClient.checkPairingStatus(machine.machineCode);
      if (check.paired) {
        SanitizedLogger.info(`[Machine] Reconnected: ${machine.machineCode} is registered and verified.`);
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        SanitizedLogger.warn(`[Machine] Worker token revoked or machine deleted for ${machine.machineCode}. Re-pairing required.`);
        isPaired = false;
        machine.machineToken = null;
        apiClient.clearToken();
      } else {
        SanitizedLogger.warn(`[Machine] Backend unreachable during startup status check. Proceeding in offline retry mode...`);
      }
    }
  }

  // If un-paired: handle interactive vs headless/Docker registration and pairing
  if (!isPaired) {
    if (isInteractive) {
      console.log('\n[Worker] Unconfigured machine detected. Initiating interactive pairing sequence...');
      const pairedOk = await machine.ensurePaired(apiClient);
      if (!pairedOk) {
        console.log('[Worker] Interactive pairing cancelled or timed out. Entering standby mode.');
        console.log(`[Worker] You can pair anytime using the SEVATN Worker Control Center.\n`);
        heartbeat.setStatus('OFFLINE');
      } else {
        isPaired = true;
      }
    } else {
      SanitizedLogger.info('=======================================================');
      SanitizedLogger.info('⚡ SEVATN WORKER RUNNING IN HEADLESS / DOCKER MODE');
      SanitizedLogger.info(`Machine Code : ${machine.machineCode}`);
      SanitizedLogger.info(`Display Name : ${machine.machineName}`);
      SanitizedLogger.info(`Backend URL  : ${backendUrl}`);
      SanitizedLogger.info('Initiating automated registration and pairing polling...');
      SanitizedLogger.info('=======================================================');

      while (!isPaired) {
        const pairedOk = await machine.ensurePaired(apiClient, {
          nonInteractive: true,
          pollIntervalMs: 3000,
          maxPollAttempts: 300, // 15-minute pairing window
        });

        if (pairedOk) {
          isPaired = true;
          break;
        }

        SanitizedLogger.warn('[Worker] Pairing window expired without approval. Regenerating pairing credentials in 5s...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  // If still un-paired (e.g. operator cancelled prompt), do not start heartbeat or orchestrator
  if (!isPaired) {
    SanitizedLogger.warn('[Worker] Worker machine is not paired. Heartbeat and job execution will not start.');
    heartbeat.setStatus('OFFLINE');
    return;
  }

  // 4. Start Heartbeat Service (only once authenticated)
  await heartbeat.init().catch(() => {});
  heartbeat.start(heartbeatInterval);
  SanitizedLogger.info(`💓 Heartbeat service active (Interval: ${heartbeatInterval / 1000}s)`);

  // 5. Start Orchestrator Loop (cadence-driven, main tick <= 500ms, default 250ms)
  const envCheckInterval = process.env.CHECK_INTERVAL_MS ? parseInt(process.env.CHECK_INTERVAL_MS, 10) : 250;
  const checkInterval = isNaN(envCheckInterval) || envCheckInterval > 500 ? 250 : Math.max(50, envCheckInterval);
  const orchestrator = new WorkerOrchestrator(apiClient, heartbeat, checkInterval);

  // Hook token revocation handler
  heartbeat.setOnAuthRevoked(() => {
    SanitizedLogger.warn('[Worker] Worker authentication was revoked by server. Stopping orchestrator...');
    orchestrator.stop();
    heartbeat.stop();
    apiClient.clearToken();
    machine.machineToken = null;
    process.exit(1); // Exit with error so container supervisor recreates/re-runs fresh pairing
  });

  // 6. Graceful Shutdown with Idempotent Cleanup
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    SanitizedLogger.info(`[Worker] Received ${signal}. Shutting down gracefully...`);

    // Stop orchestrator and polling
    orchestrator.stop();

    // Mark worker STOPPED and notify central API
    try {
      if (typeof (apiClient as any)?.sendWorkerStop === 'function') {
        await (apiClient as any).sendWorkerStop(
          `Graceful shutdown (${signal})`,
          orchestrator.getWorkerSessionId(),
        ).catch(() => {});
      }
      heartbeat.setStatus('STOPPED');
      if (typeof (heartbeat as any).sendImmediate === 'function') {
        await (heartbeat as any).sendImmediate().catch(() => {});
      }
      heartbeat.stop();
    } catch {}

    // Stop IPC server
    try {
      await ipc.stop();
    } catch {}

    // Clean up browser contexts and Chromium
    SanitizedLogger.info('[Worker] Closing active Playwright browser contexts...');
    try {
      await BrowserManager.closeBrowser();
      SanitizedLogger.info('[Worker] Chromium processes closed cleanly.');
    } catch (err: any) {
      SanitizedLogger.warn('[Worker] Warning during Chromium cleanup:', err?.message);
    }

    SanitizedLogger.info('[Worker] Graceful shutdown completed.');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Start orchestrator loop
  await orchestrator.start();
}

if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  bootstrap().catch((err) => {
    SanitizedLogger.error('Worker bootstrap unhandled failure:', err);
    console.error('\n[Worker] Fatal startup error:', err.message || err);
    process.exit(1);
  });
}
