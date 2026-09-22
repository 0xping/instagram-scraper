// Pure extraction: turns what the browser saw into profile fields. No Playwright, no DB, so it can be
// tested against fixtures. Source priority per field: Instagram's own JSON > visible DOM > OpenGraph meta.

export type AccountStatus = 'active' | 'private' | 'unavailable';
export type FieldSource = 'json' | 'dom' | 'meta';

export interface ProfileFields {
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  externalUrl: string | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  verified: boolean | null;
  category: string | null;
  isPrivate: boolean | null;
}

/** Everything read from one profile page load. Collected in the browser by profile-scraper.ts. */
export interface PageSnapshot {
  url: string;
  httpStatus: number | null;
  title: string;
  meta: Record<string, string>;
  /** Inline <script type="application/json"> blocks and network JSON bodies that mention the username. */
  jsonTexts: string[];
  dom: {
    followers: string | null;
    following: string | null;
    headerText: string | null;
    verified: boolean;
    externalHref: string | null;
    avatarSrc: string | null;
    headings: string[];
    bodyText: string;
  };
}

export interface ProfileExtraction {
  status: AccountStatus;
  fields: ProfileFields;
  sources: Partial<Record<keyof ProfileFields, FieldSource>>;
  /** The matched Instagram user object, kept as the raw source observation. */
  rawUser: Record<string, unknown> | null;
}

export class ExtractionError extends Error {
  constructor(message: string, readonly type: string, readonly retryable: boolean) {
    super(message);
  }
}

// English text patterns are the last resort; everything above them is language-independent.
const UNAVAILABLE_TEXT = /page isn[’']t available|isn[’']t available|not available|page not found|link you followed may be broken|may have been removed/i;
const PRIVATE_TEXT = /this account is private/i;
export const RATE_LIMIT_TEXT = /please wait a few minutes before you try again|try again later/i;

const PROFILE_KEYS = [
  'full_name', 'biography', 'follower_count', 'edge_followed_by', 'following_count', 'edge_follow',
  'media_count', 'all_media_count', 'edge_owner_to_timeline_media', 'is_private', 'is_verified',
  'profile_pic_url', 'profile_pic_url_hd', 'hd_profile_pic_url_info', 'external_url', 'bio_links',
  'category', 'category_name',
];

export function extractProfile(snapshot: PageSnapshot, username: string): ProfileExtraction {
  const target = username.toLowerCase();
  const users = findUserObjects(snapshot.jsonTexts, target);
  const fields = emptyFields();
  const sources: ProfileExtraction['sources'] = {};
  const set = <K extends keyof ProfileFields>(key: K, value: ProfileFields[K] | undefined, source: FieldSource): void => {
    if (fields[key] === null && value !== null && value !== undefined) {
      fields[key] = value;
      sources[key] = source;
    }
  };

  for (const user of users) {
    for (const [key, value] of Object.entries(fieldsFromUser(user)) as Array<[keyof ProfileFields, never]>) set(key, value, 'json');
  }

  const { dom, meta } = snapshot;
  set('followersCount', parseCount(dom.followers), 'dom');
  set('followingCount', parseCount(dom.following), 'dom');
  set('followingCount', parseCount(dom.headerText?.match(/([\d][\d.,\s]*[KMB]?)\s+following\b/i)?.[1]), 'dom');
  set('postsCount', parseCount(dom.headerText?.match(/([\d][\d.,\s]*[KMB]?)\s+posts?\b/i)?.[1]), 'dom');
  if (dom.verified) set('verified', true, 'dom');
  set('externalUrl', unwrapRedirect(dom.externalHref), 'dom');
  set('profileImageUrl', dom.avatarSrc, 'dom');

  const og = parseMeta(meta, target);
  set('displayName', og.displayName, 'meta');
  set('bio', og.bio, 'meta');
  set('followersCount', og.followers, 'meta');
  set('followingCount', og.following, 'meta');
  set('postsCount', og.posts, 'meta');
  set('profileImageUrl', meta['og:image'] || null, 'meta');

  const hasProfile = users.length > 0 || meta['og:type'] === 'profile' || dom.followers !== null;
  if (!hasProfile) {
    const text = [snapshot.title, ...dom.headings, dom.bodyText].join('\n');
    if (snapshot.httpStatus === 404 || UNAVAILABLE_TEXT.test(text)) {
      return { status: 'unavailable', fields, sources, rawUser: null };
    }
    throw new ExtractionError(
      `No profile data found on ${snapshot.url} (title: "${snapshot.title}"). The page layout may have changed or it did not finish loading.`,
      'unrecognized_page',
      true,
    );
  }

  if (fields.isPrivate === null && PRIVATE_TEXT.test(`${dom.headings.join('\n')}\n${dom.bodyText}`)) set('isPrivate', true, 'dom');
  return { status: fields.isPrivate ? 'private' : 'active', fields, sources, rawUser: users[0] ?? null };
}

/** Finds every object whose `username` matches, best-populated first. Other users (suggestions, tags) are ignored. */
export function findUserObjects(jsonTexts: string[], username: string): Array<Record<string, unknown>> {
  const found: Array<{ user: Record<string, unknown>; score: number }> = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value !== 'object' || value === null || depth > 80) return;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.username === 'string' && record.username.toLowerCase() === username) {
        const score = PROFILE_KEYS.filter((key) => record[key] !== undefined && record[key] !== null).length;
        if (score > 0) found.push({ user: record, score });
      }
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const text of jsonTexts) {
    try {
      walk(JSON.parse(text.replace(/^for \(;;\);/, '')), 0);
    } catch {
      // Not JSON (or truncated): other sources still apply.
    }
  }
  return found.sort((a, b) => b.score - a.score).map((entry) => entry.user);
}

/** Maps both current (xig_user / GraphQL) and older (edge_*) Instagram user shapes. */
export function fieldsFromUser(user: Record<string, unknown>): ProfileFields {
  const bioLinks = Array.isArray(user.bio_links) ? user.bio_links as Array<Record<string, unknown>> : [];
  return {
    displayName: str(user.full_name),
    bio: str(user.biography),
    profileImageUrl: str(get(user, 'hd_profile_pic_url_info', 'url')) ?? str(user.profile_pic_url_hd) ?? str(user.profile_pic_url),
    externalUrl: str(user.external_url) ?? str(bioLinks[0]?.url),
    followersCount: int(user.follower_count) ?? int(get(user, 'edge_followed_by', 'count')),
    followingCount: int(user.following_count) ?? int(get(user, 'edge_follow', 'count')),
    postsCount: int(user.media_count) ?? int(user.all_media_count) ?? int(get(user, 'edge_owner_to_timeline_media', 'count')),
    verified: typeof user.is_verified === 'boolean' ? user.is_verified : null,
    category: str(user.category) ?? str(user.category_name) ?? str(user.business_category_name),
    isPrivate: typeof user.is_private === 'boolean' ? user.is_private : null,
  };
}

/**
 * "1,660,019" -> 1660019, "1.6M" -> 1600000, "12,5 k" -> 12500, "1.234" -> 1234.
 * With a K/M/B suffix the separator is decimal; without one, separators are thousands.
 */
export function parseCount(text: string | null | undefined): number | null {
  const match = text?.match(/(\d[\d.,\s]*\d|\d)\s*([KMB])?(?!\w)/i);
  if (!match?.[1]) return null;
  const digits = match[1].trim();
  const suffix = match[2]?.toUpperCase();
  if (!suffix) {
    const value = Number(digits.replace(/[.,\s]/g, ''));
    return Number.isSafeInteger(value) ? value : null;
  }
  const value = Number(digits.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * { K: 1e3, M: 1e6, B: 1e9 }[suffix as 'K' | 'M' | 'B']);
}

/** OpenGraph fallback. og:description counts are rounded ("2M"), so they rank below JSON and DOM. */
export function parseMeta(meta: Record<string, string>, username: string) {
  const description = meta['og:description'] ?? meta.description ?? '';
  const counts = description.match(/^([\d.,]+\s*[KMB]?)\s+Followers?,\s*([\d.,]+\s*[KMB]?)\s+Following,\s*([\d.,]+\s*[KMB]?)\s+Posts?/i);
  const escaped = username.replace(/\./g, '\\.');
  const displayName = (meta['og:title'] ?? '').match(new RegExp(`^(.*?)\\s*\\(@${escaped}\\)`, 'i'))?.[1]?.trim();
  const bio = (meta.description ?? '').match(/on Instagram: "([\s\S]*)"\s*$/)?.[1]?.trim();
  return {
    displayName: displayName || null,
    bio: bio || null,
    followers: parseCount(counts?.[1]),
    following: parseCount(counts?.[2]),
    posts: parseCount(counts?.[3]),
  };
}

/** Instagram wraps outbound links as l.instagram.com/?u=<target>; return the target. */
export function unwrapRedirect(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://www.instagram.com/');
    if (url.hostname === 'l.instagram.com') return url.searchParams.get('u');
    return url.hostname.endsWith('instagram.com') ? null : url.href;
  } catch {
    return null;
  }
}

function emptyFields(): ProfileFields {
  return {
    displayName: null, bio: null, profileImageUrl: null, externalUrl: null, followersCount: null,
    followingCount: null, postsCount: null, verified: null, category: null, isPrivate: null,
  };
}

function get(value: Record<string, unknown>, key: string, child: string): unknown {
  const inner = value[key];
  return typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>)[child] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
