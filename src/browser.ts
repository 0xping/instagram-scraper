import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Logger } from './logger.js';

/** A response that never finishes must not hold a page's extraction loop open indefinitely. */
export async function waitForResponses(responses: Iterable<Promise<void>>, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(responses),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BrowserOptions {
  headed: boolean;
  navigationTimeoutMs: number;
}

/** Owns one Chromium instance and every context opened from it. close() is idempotent. */
export class BrowserManager {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;
  private readonly contexts = new Set<BrowserContext>();

  constructor(private readonly options: BrowserOptions, private readonly log: Logger) {}

  async newContext(storageStatePath?: string): Promise<BrowserContext> {
    if (!this.browser?.isConnected()) {
      this.log.debug(`Launching Chromium (${this.options.headed ? 'headed' : 'headless'})`);
      // The CLI owns Ctrl-C/SIGTERM so it can record progress before closing; Playwright's own handlers would race it.
      this.launching ??= chromium.launch({ headless: !this.options.headed, handleSIGINT: false, handleSIGTERM: false });
      try { this.browser = await this.launching; } finally { this.launching = undefined; }
    }
    const context = await this.browser.newContext(storageStatePath ? { storageState: storageStatePath } : {});
    context.setDefaultTimeout(this.options.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    this.contexts.add(context);
    context.on('close', () => this.contexts.delete(context));
    return context;
  }

  async close(): Promise<void> {
    const browser = this.browser ?? await this.launching?.catch(() => undefined);
    this.browser = undefined;
    for (const context of [...this.contexts]) await context.close().catch(() => undefined);
    this.contexts.clear();
    await browser?.close().catch(() => undefined);
    if (browser) this.log.debug('Chromium closed');
  }
}
