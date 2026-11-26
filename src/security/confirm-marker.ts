import * as fs from 'fs';
import * as path from 'path';
import { SanitizedLogger } from '../monitoring/logger';

export interface ConfirmMarkerData {
  bookingCode: string;
  jobId: string;
  date?: string;
  route?: string;
  timestamp: number;
}

export class ConfirmMarkerManager {
  private static getMarkerDir(): string {
    const dir = path.resolve(process.cwd(), 'debug', 'markers');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {}
    return dir;
  }

  private static getMarkerPath(bookingCode: string): string {
    const safeCode = bookingCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.getMarkerDir(), `${safeCode}.confirm_clicked.json`);
  }

  public static setMarker(bookingCode: string, data: Partial<ConfirmMarkerData>): void {
    if (!bookingCode) return;
    try {
      const filePath = this.getMarkerPath(bookingCode);
      const payload: ConfirmMarkerData = {
        bookingCode,
        jobId: data.jobId || '',
        date: data.date,
        route: data.route,
        timestamp: Date.now(),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      SanitizedLogger.info(`[CONFIRM-MARKER] Persisted CONFIRM_CLICKED marker for #${bookingCode} at ${filePath}`);
    } catch (err: any) {
      SanitizedLogger.warn(`[CONFIRM-MARKER] Failed to persist CONFIRM_CLICKED marker for #${bookingCode}: ${err.message}`);
    }
  }

  public static hasMarker(bookingCode: string): boolean {
    if (!bookingCode) return false;
    try {
      const filePath = this.getMarkerPath(bookingCode);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  public static getMarker(bookingCode: string): ConfirmMarkerData | null {
    if (!bookingCode) return null;
    try {
      const filePath = this.getMarkerPath(bookingCode);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[CONFIRM-MARKER] Error reading marker for #${bookingCode}: ${err.message}`);
    }
    return null;
  }

  public static clearMarker(bookingCode: string): void {
    if (!bookingCode) return;
    try {
      const filePath = this.getMarkerPath(bookingCode);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        SanitizedLogger.info(`[CONFIRM-MARKER] Cleared CONFIRM_CLICKED marker for #${bookingCode}`);
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[CONFIRM-MARKER] Failed to clear marker for #${bookingCode}: ${err.message}`);
    }
  }

  public static clearAll(): void {
    try {
      const dir = this.getMarkerDir();
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.confirm_clicked.json')) {
            try {
              fs.unlinkSync(path.join(dir, file));
            } catch {}
          }
        }
      }
    } catch {}
  }
}
