import * as fs from 'fs';
import * as path from 'path';
import { SanitizedLogger } from '../monitoring/logger';

export interface PendingCompletionData {
  jobId: string;
  bookingRequestId?: string;
  bookingCode?: string;
  accountId?: string;
  officialReference?: string;
  officialBookingReference?: string;
  cartId?: string;
  officialReceiptReference?: string;
  portalTransactionReference?: string;
  confirmationEvidence?: any;
  confirmedAt?: string;
  confirmationData?: any;
  note?: string;
  leaseGeneration?: number;
  fencingToken?: string;
  protocolVersion?: string;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
  createdAt: number;
}

export class PendingCompletionsManager {
  private static retryTimer: NodeJS.Timeout | null = null;
  private static inMemoryIndex = new Map<string, PendingCompletionData>();

  public static getStorageDir(): string {
    const customDir = process.env.PENDING_COMPLETIONS_DIR;
    if (customDir) {
      if (!fs.existsSync(customDir)) {
        try { fs.mkdirSync(customDir, { recursive: true }); } catch {}
      }
      return customDir;
    }

    // Windows standard service path with fallback to workspace data directory
    const preferredPath = process.platform === 'win32'
      ? path.join('C:', 'ProgramData', 'SEVATN', 'Worker', 'pending-completions')
      : path.join('/var', 'lib', 'sevatn', 'pending-completions');

    try {
      if (!fs.existsSync(preferredPath)) {
        fs.mkdirSync(preferredPath, { recursive: true });
      }
      // Test write permissions
      const testFile = path.join(preferredPath, `.write_test_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok', 'utf-8');
      fs.unlinkSync(testFile);
      return preferredPath;
    } catch {
      const fallback = path.resolve(process.cwd(), 'data', 'pending-completions');
      if (!fs.existsSync(fallback)) {
        try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
      }
      return fallback;
    }
  }

  private static getFilePath(jobId: string): string {
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.getStorageDir(), `pending-${safeJobId}.json`);
  }

  public static init(apiClient?: any): void {
    this.loadAll();
    if (apiClient) {
      this.startRetryLoop(apiClient);
    }
  }

  public static loadAll(): PendingCompletionData[] {
    const dir = this.getStorageDir();
    this.inMemoryIndex.clear();
    const items: PendingCompletionData[] = [];

    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json'));
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
            const data: PendingCompletionData = JSON.parse(raw);
            if (data.jobId) {
              this.inMemoryIndex.set(data.jobId, data);
              if (data.bookingRequestId) this.inMemoryIndex.set(data.bookingRequestId, data);
              if (data.bookingCode) this.inMemoryIndex.set(data.bookingCode, data);
              items.push(data);
            }
          } catch (readErr: any) {
            SanitizedLogger.warn(`[PENDING-COMPLETIONS] Failed to parse ${file}: ${readErr.message}`);
          }
        }
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[PENDING-COMPLETIONS] Error scanning directory ${dir}: ${err.message}`);
    }

    if (items.length > 0) {
      SanitizedLogger.info(`[PENDING-COMPLETIONS] Loaded ${items.length} pending completion(s) from persistent disk cache at ${dir}`);
    }
    return items;
  }

  public static savePending(data: Omit<PendingCompletionData, 'attempts' | 'nextRetryAt' | 'createdAt'> & Partial<Pick<PendingCompletionData, 'attempts' | 'nextRetryAt' | 'createdAt'>>): string {
    const fullData: PendingCompletionData = {
      ...data,
      attempts: data.attempts ?? 0,
      nextRetryAt: data.nextRetryAt ?? Date.now(),
      createdAt: data.createdAt ?? Date.now(),
    };

    const filePath = this.getFilePath(fullData.jobId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(fullData, null, 2), 'utf-8');
      this.inMemoryIndex.set(fullData.jobId, fullData);
      if (fullData.bookingRequestId) this.inMemoryIndex.set(fullData.bookingRequestId, fullData);
      if (fullData.bookingCode) this.inMemoryIndex.set(fullData.bookingCode, fullData);
      SanitizedLogger.info(`[PENDING-COMPLETIONS] Persisted pending completion for Job #${fullData.jobId} (Ref: ${fullData.officialBookingReference || fullData.officialReference}) to ${filePath}`);
    } catch (err: any) {
      SanitizedLogger.error(`[PENDING-COMPLETIONS] Failed to persist pending completion for Job #${fullData.jobId}: ${err.message}`);
    }
    return filePath;
  }

  public static removePending(jobId: string): void {
    const filePath = this.getFilePath(jobId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        SanitizedLogger.info(`[PENDING-COMPLETIONS] Successfully removed pending completion file: ${filePath}`);
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[PENDING-COMPLETIONS] Could not unlink ${filePath}: ${err.message}`);
    }

    const item = this.inMemoryIndex.get(jobId);
    if (item) {
      this.inMemoryIndex.delete(jobId);
      if (item.bookingRequestId) this.inMemoryIndex.delete(item.bookingRequestId);
      if (item.bookingCode) this.inMemoryIndex.delete(item.bookingCode);
    }
  }

  public static hasPending(key: string): boolean {
    if (!key) return false;
    return this.inMemoryIndex.has(key);
  }

  public static getPending(key: string): PendingCompletionData | undefined {
    if (!key) return undefined;
    return this.inMemoryIndex.get(key);
  }

  /**
   * Exponential backoff delays in milliseconds:
   * Attempt 1: 30s
   * Attempt 2: 1m (60s)
   * Attempt 3: 5m (300s)
   * Attempt 4: 15m (900s)
   * Attempt 5+: 15m (900s)
   */
  public static getBackoffDelayMs(attempt: number): number {
    switch (attempt) {
      case 1:
        return 30 * 1000;
      case 2:
        return 60 * 1000;
      case 3:
        return 5 * 60 * 1000;
      default:
        return 15 * 60 * 1000;
    }
  }

  public static async processPending(apiClient: any): Promise<void> {
    const all = Array.from(new Set(Array.from(this.inMemoryIndex.values())));
    if (all.length === 0) return;

    const now = Date.now();
    for (const item of all) {
      if (now < item.nextRetryAt) {
        continue;
      }

      SanitizedLogger.info(`[PENDING-COMPLETIONS] Retrying completion sync for Job #${item.jobId} (Attempt ${item.attempts + 1})...`);
      try {
        const res = await apiClient.completeJob(item.jobId, {
          officialReference: item.officialReference,
          officialBookingReference: item.officialBookingReference,
          cartId: item.cartId,
          officialReceiptReference: item.officialReceiptReference,
          portalTransactionReference: item.portalTransactionReference,
          confirmationEvidence: item.confirmationEvidence,
          confirmedAt: item.confirmedAt,
          confirmationData: item.confirmationData,
          note: item.note,
          leaseGeneration: item.leaseGeneration ?? 1,
          fencingToken: item.fencingToken ?? 'fallback-token',
          protocolVersion: item.protocolVersion ?? 'v2.0-fenced',
        });

        SanitizedLogger.info(`[PENDING-COMPLETIONS] Sync succeeded for Job #${item.jobId} (Ref: ${item.officialBookingReference || item.officialReference})! Removing from disk.`);
        this.removePending(item.jobId);
      } catch (err: any) {
        // If already completed or authoritative pass is verified on backend
        if (err?.response?.status === 409 && (err?.message?.includes('already confirmed') || err?.response?.data?.message?.includes('already confirmed') || err?.response?.data?.message?.includes('Already completed'))) {
          SanitizedLogger.info(`[PENDING-COMPLETIONS] Job #${item.jobId} already confirmed on server. Removing pending completion.`);
          this.removePending(item.jobId);
          continue;
        }

        const newAttempts = item.attempts + 1;
        const delayMs = this.getBackoffDelayMs(newAttempts);
        item.attempts = newAttempts;
        item.nextRetryAt = now + delayMs;
        item.lastError = err?.message || String(err);

        SanitizedLogger.warn(`[PENDING-COMPLETIONS] Sync failed for Job #${item.jobId}: ${item.lastError}. Next retry in ${delayMs / 1000}s.`);
        this.savePending(item);
      }
    }
  }

  public static startRetryLoop(apiClient: any, intervalMs = 15000): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      this.processPending(apiClient).catch((err) => {
        SanitizedLogger.warn(`[PENDING-COMPLETIONS] Background sweep error: ${err.message}`);
      });
    }, intervalMs);
    // Trigger initial run immediately
    this.processPending(apiClient).catch(() => {});
  }

  public static stopRetryLoop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  public static clearAll(): void {
    this.stopRetryLoop();
    const dir = this.getStorageDir();
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json'));
        for (const file of files) {
          try { fs.unlinkSync(path.join(dir, file)); } catch {}
        }
      }
    } catch {}
    this.inMemoryIndex.clear();
  }
}
