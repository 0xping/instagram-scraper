import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  /**
   * The installed browser to drive ('chrome', 'msedge', …) instead of Playwright's own Chromium build.
   * Instagram's security check refuses to accept a correct answer in that build on macOS; real Chrome passes it.
   * Empty falls back to the bundled Chromium, and so does a missing channel.
   */
  channel?: string;
  /**
   * A browser profile kept between runs. Without one Instagram meets a device it has never seen on every
   * launch, which is what its challenge is looking for. Empty opens a throwaway profile each time.
   */
  profileDir?: string;
}

/** Owns one Chromium instance and every context opened from it. close() is idempotent. */
export class BrowserManager {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;
  private persistent: BrowserContext | undefined;
  private readonly contexts = new Set<BrowserContext>();

  constructor(private readonly options: BrowserOptions, private readonly log: Logger) {}

  async newContext(storageStatePath?: string): Promise<BrowserContext> {
    if (this.options.profileDir) return this.keptProfile(storageStatePath);
    if (!this.browser?.isConnected()) {
      this.log.debug(`Launching Chromium (${this.options.headed ? 'headed' : 'headless'})`);
      // The CLI owns Ctrl-C/SIGTERM so it can record progress before closing; Playwright's own handlers would race it.
      this.launching ??= chromium.launch({ ...this.launchOptions(), channel: this.options.channel || undefined })
        .catch((error: unknown) => {
          if (!this.options.channel) throw error;
          this.warnMissingChannel();
          return chromium.launch(this.launchOptions());
        });
      try { this.browser = await this.launching; } finally { this.launching = undefined; }
    }
    const context = await this.browser.newContext(storageStatePath ? { storageState: storageStatePath } : {});
    this.track(context);
    return context;
  }

  /**
   * The one context of a profile that survives the run. Every caller shares it: a profile directory
   * belongs to a single browser process, and Instagram should meet the same device each time anyway.
   */
  private async keptProfile(storageStatePath?: string): Promise<BrowserContext> {
    const dir = this.options.profileDir as string;
    if (!this.persistent) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.log.debug(`Launching ${this.options.channel || 'Chromium'} with the profile in ${dir}`);
      this.persistent = await chromium.launchPersistentContext(dir, { ...this.launchOptions(), channel: this.options.channel || undefined })
        .catch((error: unknown) => {
          if (!this.options.channel) throw error;
          this.warnMissingChannel();
          return chromium.launchPersistentContext(dir, this.launchOptions());
        });
      this.track(this.persistent);
      this.persistent.on('close', () => { this.persistent = undefined; });
    }
    // Cookies saved by an earlier login (or pasted from your own browser) join the profile's own.
    if (storageStatePath && existsSync(storageStatePath)) {
      const saved = JSON.parse(readFileSync(storageStatePath, 'utf8')) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
      if (saved.cookies?.length) await this.persistent.addCookies(saved.cookies);
    }
    return this.persistent;
  }

  private launchOptions() {
    // The CLI owns Ctrl-C/SIGTERM so it can record progress before closing; Playwright's own handlers would race it.
    return { headless: !this.options.headed, handleSIGINT: false, handleSIGTERM: false };
  }

  private warnMissingChannel(): void {
    this.log.warn(`${this.options.channel} is not installed; using the bundled Chromium. Instagram's security check is stricter with it.`);
  }

  private track(context: BrowserContext): void {
    context.setDefaultTimeout(this.options.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    this.contexts.add(context);
    context.on('close', () => this.contexts.delete(context));
  }

  async close(): Promise<void> {
    const browser = this.browser ?? await this.launching?.catch(() => undefined);
    this.browser = undefined;
    this.persistent = undefined;
    for (const context of [...this.contexts]) await context.close().catch(() => undefined);
    this.contexts.clear();
    await browser?.close().catch(() => undefined);
    if (browser) this.log.debug('Chromium closed');
  }
}
