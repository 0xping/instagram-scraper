import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserManager } from './browser.js';
import type { Logger } from './logger.js';

const HOME_URL = 'https://www.instagram.com/';
const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const POLL_MS = 2000;
const SETTLE_MS = 1500;
const LOAD_WAIT_MS = 10_000;

// URL/DOM heuristics only: Instagram's page text is localized and changes often.
const CHALLENGE_PATH = /^\/(challenge|auth_platform|accounts\/suspended|accounts\/login\/two_factor)(\/|$)/;
const CHALLENGE_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'input[name="verificationCode"]',
  'input[name="security_code"]',
].join(',');

export type SessionState = 'authenticated' | 'logged_out' | 'challenge';

export class SessionExpiredError extends Error {}
export class ManualInterventionError extends Error {}

const challengeMessage =
  'Instagram is showing a security challenge (CAPTCHA, 2FA, checkpoint, or suspicious-login confirmation). ' +
  'Manual intervention is required: run `npm run instagram:login`, complete it yourself in the browser window, then retry. ' +
  'This tool never attempts to bypass it.';

export class InstagramSessionManager {
  constructor(
    private readonly browser: BrowserManager,
    private readonly statePath: string,
    private readonly loginTimeoutMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * Interactive login. The user authenticates by hand in a headed window; we only watch for the
   * result. A security challenge is left for the user to complete: nothing here touches the page.
   */
  async login(): Promise<void> {
    const context = await this.browser.newContext(existsSync(this.statePath) ? this.statePath : undefined);
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    this.log.info(`Log in to Instagram in the browser window (waiting up to ${Math.round(this.loginTimeoutMs / 60000)} min). Credentials are never read or stored by this tool.`);

    const deadline = Date.now() + this.loginTimeoutMs;
    let warned = false;
    while (Date.now() < deadline) {
      const igPages = context.pages().filter((p) => p.url().includes('instagram.com'));
      if (context.pages().length === 0) throw new Error('Browser window was closed before login finished; nothing was saved.');
      const current = igPages.at(-1);
      const state = current ? await this.inspect(current).catch(() => 'logged_out' as const) : 'logged_out';

      if (state === 'challenge' && !warned) {
        warned = true;
        this.log.warn('Instagram is showing a security challenge. Complete it yourself in the browser window; waiting.');
      }
      if (state === 'authenticated') {
        // Confirm from a fresh navigation so a half-finished login is never saved.
        if (await this.verify(context) === 'authenticated') {
          await this.saveState(context);
          this.log.info(`Login verified. Session saved to ${this.statePath}`);
          return;
        }
        this.log.debug('Session cookie present but home page did not confirm login yet; still waiting');
      }
      await sleep(POLL_MS);
    }
    throw new Error(`Login was not completed within ${Math.round(this.loginTimeoutMs / 60000)} minutes; nothing was saved.`);
  }

  /**
   * Opens a context from the saved session and confirms it is still logged in.
   * The caller owns the returned context (BrowserManager.close() also cleans it up).
   */
  async open(): Promise<BrowserContext> {
    if (!existsSync(this.statePath)) {
      throw new SessionExpiredError('No saved Instagram session. Run: npm run instagram:login');
    }
    const context = await this.browser.newContext(this.statePath);
    try {
      const state = await this.verify(context);
      if (state === 'challenge') throw new ManualInterventionError(challengeMessage);
      if (state === 'logged_out') {
        throw new SessionExpiredError('Saved Instagram session has expired. Run: npm run instagram:login');
      }
      await this.saveState(context); // keep rotated cookies
      this.log.debug('Saved Instagram session is still authenticated');
      return context;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  /** Loads the home page in a throwaway tab and classifies where Instagram sent us. */
  async verify(context: BrowserContext): Promise<SessionState> {
    const page = await context.newPage();
    try {
      // Instagram's home page can keep loading resources past the navigation timeout, so the full `load` event
      // is waited for only briefly, like every other page here.
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('load', { timeout: LOAD_WAIT_MS }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS); // let client-side redirects (e.g. to /accounts/login/) land
      return await this.inspect(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Classifies the current page without navigating. */
  async inspect(page: Page): Promise<SessionState> {
    const { pathname } = new URL(page.url());
    if (CHALLENGE_PATH.test(pathname) || await page.locator(CHALLENGE_SELECTOR).count() > 0) return 'challenge';
    const cookies = await page.context().cookies(HOME_URL);
    const hasSession = cookies.some((c) => c.name === 'sessionid' && c.value !== '');
    if (!hasSession || pathname.startsWith('/accounts/login') || await page.locator('input[name="password"]').count() > 0) {
      return 'logged_out';
    }
    return 'authenticated';
  }

  /** Writes the state file (cookies + localStorage) atomically, readable only by the current user. */
  async saveState(context: BrowserContext): Promise<void> {
    const state = await context.storageState();
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.statePath), 0o700);
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flush: true });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.statePath);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
