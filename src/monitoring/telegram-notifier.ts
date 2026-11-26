import * as https from 'https';
import { SanitizedLogger } from './logger';

export interface TelegramFailureAlertPayload {
  bookingId: string;
  bookingCode?: string;
  requestedDate: string;
  route: string;
  failureStage: string;
  errorMessage: string;
  retryAttempt?: number;
  maxRetries?: number;
  screenshotBase64?: string;
}

export class TelegramFailureNotifier {
  private static dedupAlertCache = new Map<string, number>();
  private static readonly DEDUP_COOLDOWN_MS = 15000;

  /**
   * Dispatches real-time screenshot and failure context alert to configured Telegram destination
   */
  public static async sendFailureAlert(payload: TelegramFailureAlertPayload): Promise<{
    success: boolean;
    deliveredVia: 'TELEGRAM_DIRECT' | 'LOGGER_ONLY';
    error?: string;
  }> {
    const {
      bookingId,
      bookingCode = bookingId,
      requestedDate,
      route,
      failureStage,
      errorMessage,
      retryAttempt = 1,
      maxRetries = 3,
      screenshotBase64,
    } = payload;

    // Deduplication key: avoid spamming duplicate identical failure alerts in quick succession
    const dedupKey = `${bookingId}:${failureStage}:${retryAttempt}:${errorMessage.slice(0, 40)}`;
    const now = Date.now();
    const lastSent = this.dedupAlertCache.get(dedupKey);
    if (lastSent && now - lastSent < this.DEDUP_COOLDOWN_MS) {
      return { success: true, deliveredVia: 'LOGGER_ONLY', error: 'Deduplicated duplicate failure alert' };
    }
    this.dedupAlertCache.set(dedupKey, now);

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

    const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const formattedCaption = [
      `🚨 <b>BOOKING FAILURE ALERT • ServiceTN Worker</b>`,
      ``,
      `📋 <b>Booking ID:</b> <code>${bookingCode}</code> (${bookingId})`,
      `📅 <b>Requested Date:</b> <code>${requestedDate}</code>`,
      `🛣 <b>Route:</b> ${route}`,
      `🛑 <b>Failure Stage:</b> <code>${failureStage}</code>`,
      `❌ <b>Error:</b> ${errorMessage}`,
      `🔄 <b>Retry Attempt:</b> ${retryAttempt} of ${maxRetries}`,
      `⏱ <b>Time:</b> ${timeStr} IST`,
    ].join('\n');

    SanitizedLogger.error(
      `[TELEGRAM-ALERT] Failure Alert: bookingId=${bookingCode} stage=${failureStage} attempt=${retryAttempt}/${maxRetries} error="${errorMessage}"`,
    );

    if (!botToken || !chatId) {
      SanitizedLogger.warn(
        `[TELEGRAM-ALERT] Direct Telegram credentials not configured in worker environment (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). Direct Telegram dispatch skipped. Screenshot forwarded to central API job failure report.`,
      );
      return { success: false, deliveredVia: 'LOGGER_ONLY', error: 'DIRECT_CREDENTIALS_NOT_CONFIGURED' };
    }

    try {
      if (screenshotBase64 && screenshotBase64.length > 50) {
        // Strip data URI header if present
        let cleanBase64 = screenshotBase64;
        let mimeType = 'image/png';
        if (cleanBase64.startsWith('data:')) {
          const match = cleanBase64.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            mimeType = match[1];
            cleanBase64 = match[2];
          }
        }
        const imgBuffer = Buffer.from(cleanBase64, 'base64');

        const sentPhoto = await this.sendTelegramPhoto(botToken, chatId, imgBuffer, formattedCaption, mimeType);
        if (sentPhoto.success) {
          SanitizedLogger.info(`[TELEGRAM-ALERT] ✅ Failure screenshot successfully delivered to Telegram chat ${chatId} (messageId: ${sentPhoto.messageId || 'N/A'})`);
          return { success: true, deliveredVia: 'TELEGRAM_DIRECT' };
        } else {
          SanitizedLogger.warn(`[TELEGRAM-ALERT] ⚠️ Telegram photo dispatch returned error: ${sentPhoto.error}. Trying text fallback...`);
        }
      }

      // Fallback: send text message if screenshot was missing or photo send failed
      const sentMsg = await this.sendTelegramMessage(botToken, chatId, formattedCaption);
      if (sentMsg.success) {
        SanitizedLogger.info(`[TELEGRAM-ALERT] ✅ Failure text message delivered to Telegram chat ${chatId} (messageId: ${sentMsg.messageId || 'N/A'})`);
        return { success: true, deliveredVia: 'TELEGRAM_DIRECT' };
      } else {
        SanitizedLogger.error(`[TELEGRAM-ALERT] ❌ Telegram delivery failed: ${sentMsg.error}`);
        return { success: false, deliveredVia: 'LOGGER_ONLY', error: sentMsg.error };
      }
    } catch (err: any) {
      SanitizedLogger.warn(`[TELEGRAM-ALERT] ⚠️ Telegram dispatch failed: ${err?.message || err}`);
      return { success: false, deliveredVia: 'LOGGER_ONLY', error: err?.message || String(err) };
    }
  }

  private static sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<{ success: boolean; messageId?: number; error?: string }> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });

      const req = https.request(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 8000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode === 200 && parsed.ok === true) {
                resolve({ success: true, messageId: parsed.result?.message_id });
              } else {
                resolve({ success: false, error: parsed.description || `HTTP_${res.statusCode}` });
              }
            } catch {
              resolve({ success: res.statusCode === 200, error: `PARSE_ERROR_HTTP_${res.statusCode}` });
            }
          });
        },
      );

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'TIMEOUT' });
      });
      req.write(payload);
      req.end();
    });
  }

  private static sendTelegramPhoto(
    botToken: string,
    chatId: string,
    photoBuffer: Buffer,
    caption: string,
    mimeType: string,
  ): Promise<{ success: boolean; messageId?: number; error?: string }> {
    return new Promise((resolve) => {
      const boundary = `----TelegramBoundary${Date.now()}`;
      const header =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
        `${chatId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption.slice(0, 1000)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="parse_mode"\r\n\r\n` +
        `HTML\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="failure_screenshot.png"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`;

      const footer = `\r\n--${boundary}--\r\n`;

      const headerBuf = Buffer.from(header, 'utf8');
      const footerBuf = Buffer.from(footer, 'utf8');
      const totalLength = headerBuf.length + photoBuffer.length + footerBuf.length;

      const req = https.request(
        `https://api.telegram.org/bot${botToken}/sendPhoto`,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': totalLength,
          },
          timeout: 12000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode === 200 && parsed.ok === true) {
                resolve({ success: true, messageId: parsed.result?.message_id });
              } else {
                resolve({ success: false, error: parsed.description || `HTTP_${res.statusCode}` });
              }
            } catch {
              resolve({ success: res.statusCode === 200, error: `PARSE_ERROR_HTTP_${res.statusCode}` });
            }
          });
        },
      );

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'TIMEOUT' });
      });

      req.write(headerBuf);
      req.write(photoBuffer);
      req.write(footerBuf);
      req.end();
    });
  }

  public static clearCache(): void {
    this.dedupAlertCache.clear();
  }
}
