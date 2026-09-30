import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
  /** false keeps a headed window out of sight (off screen and minimized). Instagram degrades headless pages, so hiding must stay headed. */
  show?: boolean;
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
  private xvfb: Promise<{ process: ChildProcess; display: string } | null> | undefined;

  constructor(private readonly options: BrowserOptions, private readonly log: Logger) {}

  async newContext(storageStatePath?: string): Promise<BrowserContext> {
    if (this.options.profileDir) return this.keptProfile(storageStatePath);
    if (!this.browser?.isConnected()) {
      this.log.debug(`Launching Chromium (${this.options.headed ? 'headed' : 'headless'})`);
      // The CLI owns Ctrl-C/SIGTERM so it can record progress before closing; Playwright's own handlers would race it.
      this.launching ??= this.launchOptions().then((options) => chromium.launch({ ...options, channel: this.options.channel || undefined })
        .catch((error: unknown) => {
          if (!this.options.channel) throw error;
          this.warnMissingChannel();
          return chromium.launch(options);
        }));
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
      const options = await this.launchOptions();
      this.persistent = await chromium.launchPersistentContext(dir, { ...options, channel: this.options.channel || undefined })
        .catch((error: unknown) => {
          if (!this.options.channel) throw error;
          this.warnMissingChannel();
          return chromium.launchPersistentContext(dir, options);
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

  private async launchOptions() {
    // The CLI owns Ctrl-C/SIGTERM so it can record progress before closing; Playwright's own handlers would race it.
    const args = this.hidden ? ['--window-position=-32000,-32000'] : [];
    return { headless: !this.options.headed, args, env: await this.hiddenScreen(), handleSIGINT: false, handleSIGTERM: false };
  }

  /**
   * Linux: a hidden window goes on a virtual screen (Xvfb), still headed. WSL and Wayland pull an off-screen
   * window back into view and ignore minimize, so the window would otherwise show. Without Xvfb, it may show.
   */
  private async hiddenScreen(): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.hidden || process.platform !== 'linux') return undefined;
    this.xvfb ??= startXvfb();
    const xvfb = await this.xvfb;
    if (!xvfb) {
      this.log.warn('Could not start a hidden screen for the browser, so its window may show. On Linux this needs Xvfb: sudo apt install xvfb');
      return undefined;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: xvfb.display };
    delete env.WAYLAND_DISPLAY; // Chrome would open on the real screen through Wayland instead
    return env;
  }

  /** A headed window kept out of sight. Headless is not an option: Instagram degrades headless pages. */
  private get hidden(): boolean {
    return this.options.headed && this.options.show === false;
  }

  /**
   * macOS and Wayland clamp an off-screen window back into view, so the window is also minimized to the Dock.
   * Playwright's default flags keep a minimized window rendering, so scrolling and extraction are unaffected.
   */
  private async minimize(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach();
    } catch (error) {
      this.log.debug(`Could not minimize the browser window: ${(error as Error).message}`);
    }
  }

  private warnMissingChannel(): void {
    this.log.warn(`${this.options.channel} is not installed; using the bundled Chromium. Instagram's security check is stricter with it.`);
  }

  private track(context: BrowserContext): void {
    context.setDefaultTimeout(this.options.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    this.contexts.add(context);
    if (this.hidden) {
      for (const page of context.pages()) void this.minimize(page);
      context.on('page', (page) => void this.minimize(page));
    }
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
    (await this.xvfb)?.process.kill();
    this.xvfb = undefined;
  }
}

/** Starts a virtual X screen on a free display number, or null when Xvfb is not installed or does not start. */
export function startXvfb(): Promise<{ process: ChildProcess; display: string } | null> {
  // Numbers from 99 up: WSL's own screen :0 leaves no lock file, and Xvfb would otherwise take :0 over.
  let n = 99;
  while (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) n++;
  return new Promise((resolve) => {
    // Only the abstract socket: WSL mounts /tmp/.X11-unix read-only. -displayfd writes the number to fd 3 once the
    // screen is ready; -terminate exits once the browser disconnects.
    const child = spawn('Xvfb', [`:${n}`, '-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-nolisten', 'unix', '-terminate'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 10_000);
    child.stdio[3]!.once('data', () => {
      clearTimeout(timer);
      resolve({ process: child, display: `:${n}` });
    });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('exit', () => { clearTimeout(timer); resolve(null); });
  });
}
