// Pure post extraction: page snapshot in, fields out. No Playwright or DB, so it is tested against fixtures.
// Source priority per field: Instagram's media object (JSON) > page structure (DOM) > OpenGraph meta.

import { parseCount } from './profile-extract.js';

export type PostType = 'image' | 'carousel' | 'reel' | 'unknown';
export type Availability = 'available' | 'unavailable' | 'restricted';
export type Source = 'json' | 'dom' | 'meta' | 'caption';

export interface PostSnapshot {
  url: string;
  httpStatus: number | null;
  title: string;
  meta: Record<string, string>;
  /** Inline JSON blocks and network JSON bodies that mention the shortcode. */
  jsonTexts: string[];
  dom: {
    caption: string | null;
    datetime: string | null;
    likesText: string | null;
    videoDuration: number | null;
    hasVideo: boolean;
    bodyText: string;
  };
}

export interface MediaItem {
  position: number;
  mediaType: 'image' | 'video' | 'unknown';
  sourceUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  altText: string | null;
  raw: Record<string, unknown> | null;
}

export interface PostFields {
  instagramPostId: string | null;
  type: PostType;
  productType: string | null;
  ownerUsername: string | null;
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  taggedUsers: string[];
  coauthors: string[];
  location: string | null;
  publishedAt: string | null;
  accessibilityCaption: string | null;
  likesCount: number | null;
  likesHidden: boolean | null;
  commentsCount: number | null;
  commentsDisabled: boolean | null;
  viewsCount: number | null;
  playsCount: number | null;
  durationSeconds: number | null;
  audioTitle: string | null;
  audioArtist: string | null;
  audioType: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  carouselCount: number | null;
}

export type PostExtraction =
  | { availability: 'available'; fields: PostFields; items: MediaItem[]; sources: Partial<Record<keyof PostFields, Source>>; raw: Record<string, unknown> | null }
  | { availability: 'unavailable' | 'restricted'; reason: string };

export class PostExtractionError extends Error {
  constructor(message: string, readonly type: string, readonly retryable: boolean) {
    super(message);
  }
}

// English text is the last resort; the JSON and status-code checks above it are language-independent.
const UNAVAILABLE_TEXT = /page isn[’']t available|isn[’']t available|may have been removed|post isn[’']t available|content isn[’']t available/i;
const RESTRICTED_TEXT = /this account is private|follow (this account|to see)|restricted to|age[- ]restricted|you must be \d+/i;

export function extractPost(snapshot: PostSnapshot, shortcode: string): PostExtraction {
  const media = findMediaObjects(snapshot.jsonTexts, shortcode);
  const { meta, dom } = snapshot;
  const hasPostMeta = /^(article|video|instapp:photo|website)/.test(meta['og:type'] ?? '') && (meta['og:url'] ?? '').includes(shortcode);

  if (media.length === 0 && !hasPostMeta) {
    const text = `${snapshot.title}\n${dom.bodyText}`;
    if (snapshot.httpStatus === 404 || snapshot.httpStatus === 410 || UNAVAILABLE_TEXT.test(text)) {
      return { availability: 'unavailable', reason: 'Instagram says this post is not available (deleted, or never existed).' };
    }
    if (RESTRICTED_TEXT.test(text)) return { availability: 'restricted', reason: 'Post is not visible to this session (private or restricted account).' };
    throw new PostExtractionError(
      `No post data found on ${snapshot.url} (title: "${snapshot.title}"). The page layout may have changed or it did not finish loading.`,
      'unrecognized_page', true,
    );
  }

  const fields = emptyFields();
  const sources: Partial<Record<keyof PostFields, Source>> = {};
  const set = <K extends keyof PostFields>(key: K, value: PostFields[K] | null | undefined, source: Source): void => {
    const current = fields[key];
    const empty = current === null || (Array.isArray(current) && current.length === 0) || (key === 'type' && current === 'unknown');
    const has = value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0) && !(key === 'type' && value === 'unknown');
    if (empty && has) {
      fields[key] = value as PostFields[K];
      sources[key] = source;
    }
  };

  const best = media[0] ?? null;
  let items: MediaItem[] = [];
  if (best) {
    const fromJson = fieldsFromMedia(best);
    for (const [key, value] of Object.entries(fromJson) as Array<[keyof PostFields, never]>) set(key, value, 'json');
    items = mediaItems(best);
  }

  // DOM and meta only fill what the media object did not provide.
  const ogCaption = (meta['og:title'] ?? '').match(/on Instagram: "([\s\S]*)"\s*$/)?.[1] ?? null;
  set('caption', dom.caption, 'dom');
  set('caption', ogCaption, 'meta'); // og:title can be truncated for long captions; the source records that
  set('publishedAt', isoOrNull(dom.datetime), 'dom');
  if (fields.likesHidden !== true) set('likesCount', parseCount(dom.likesText), 'dom');
  set('durationSeconds', dom.videoDuration !== null && Number.isFinite(dom.videoDuration) && dom.videoDuration > 0 ? round(dom.videoDuration) : null, 'dom');
  set('thumbnailUrl', meta['og:image'] || null, 'meta');
  const ogPath = safeUrl(meta['og:url'])?.pathname ?? '';
  set('ownerUsername', ogPath.match(/^\/([A-Za-z0-9._]+)\/(?:p|reel)\//)?.[1]?.toLowerCase() ?? null, 'meta');
  set('type', /\/reel\//.test(ogPath) || (dom.hasVideo && !best) ? 'reel' : 'unknown', 'meta');

  // Hashtags and mentions come from the final caption, whatever its source.
  const entities = captionEntities(fields.caption);
  set('hashtags', entities.hashtags, 'caption');
  set('mentions', entities.mentions, 'caption');

  if (fields.type === 'carousel') set('carouselCount', items.length || null, 'json');
  return { availability: 'available', fields, items, sources, raw: best };
}

/** Every object with this shortcode and a timestamp, most complete first (feeds can hold other posts too). */
export function findMediaObjects(jsonTexts: string[], shortcode: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value !== 'object' || value === null || depth > 80) return;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.code === shortcode && (record.taken_at !== undefined || record.media_type !== undefined)) found.push(record);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const text of jsonTexts) {
    try {
      walk(JSON.parse(text.replace(/^for \(;;\);/, '')), 0);
    } catch {
      // not JSON; other sources still apply
    }
  }
  return found.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
}

export function fieldsFromMedia(m: Record<string, unknown>): PostFields {
  const hidden = typeof m.like_and_view_counts_disabled === 'boolean' ? m.like_and_view_counts_disabled : null;
  const caption = str(obj(m.caption)?.text);
  const clips = obj(m.clips_metadata);
  const music = obj(obj(clips?.music_info)?.music_asset_info);
  const original = obj(clips?.original_sound_info);
  const carousel = Array.isArray(m.carousel_media) ? m.carousel_media : [];
  const candidates = [largest(arr(obj(m.image_versions2)?.candidates))];
  const tagged = new Set<string>();
  for (const source of [m, ...carousel]) {
    for (const tag of arr(obj(obj(source)?.usertags)?.in)) {
      const name = str(obj(obj(tag)?.user)?.username);
      if (name) tagged.add(name.toLowerCase());
    }
  }
  const takenAt = typeof m.taken_at === 'number' ? new Date(m.taken_at * 1000).toISOString() : null;
  return {
    instagramPostId: str(m.pk) ?? (typeof m.pk === 'number' ? String(m.pk) : null) ?? str(m.id)?.split('_')[0] ?? null,
    type: postType(m),
    productType: str(m.product_type),
    ownerUsername: str(obj(m.user)?.username)?.toLowerCase() ?? str(obj(m.owner)?.username)?.toLowerCase() ?? null,
    caption,
    hashtags: [],
    mentions: [],
    taggedUsers: [...tagged],
    coauthors: arr(m.coauthor_producers).map((u) => str(obj(u)?.username)?.toLowerCase()).filter((u): u is string => !!u),
    location: str(obj(m.location)?.name),
    publishedAt: takenAt,
    accessibilityCaption: str(m.accessibility_caption),
    // When the owner hides counts, Instagram may still send a number; the UI does not show it, so neither do we.
    // The untouched value stays in raw_json.
    likesCount: hidden ? null : int(m.like_count),
    likesHidden: hidden,
    commentsCount: int(m.comment_count),
    commentsDisabled: typeof m.comments_disabled === 'boolean' ? m.comments_disabled : null,
    viewsCount: hidden ? null : int(m.view_count) ?? int(m.video_view_count),
    playsCount: hidden ? null : int(m.ig_play_count) ?? int(m.play_count),
    durationSeconds: num(m.video_duration) ?? dashDuration(m.video_dash_manifest),
    audioTitle: str(music?.title) ?? str(original?.original_audio_title),
    audioArtist: str(music?.display_artist) ?? str(obj(original?.ig_artist)?.username),
    audioType: str(clips?.audio_type),
    thumbnailUrl: str(obj(candidates[0])?.url) ?? str(m.display_uri) ?? str(m.thumbnail_src),
    width: int(m.original_width) || null,
    height: int(m.original_height) || null,
    carouselCount: int(m.carousel_media_count) ?? (carousel.length || null),
  };
}

/** One row per media item: the single image/video, or each carousel slide in order. */
export function mediaItems(m: Record<string, unknown>): MediaItem[] {
  const carousel = arr(m.carousel_media).map(obj).filter((x): x is Record<string, unknown> => x !== null);
  return (carousel.length ? carousel : [m]).map((item, position) => {
    const video = largest(arr(item.video_versions));
    const image = largest(arr(obj(item.image_versions2)?.candidates));
    const isVideo = item.media_type === 2 || video !== null;
    return {
      position,
      mediaType: item.media_type === 1 ? 'image' : isVideo ? 'video' : 'unknown',
      sourceUrl: str(video?.url) ?? str(image?.url),
      // Size of the version that gets downloaded; the post row keeps the original upload size.
      width: int((video ?? image)?.width) || int(item.original_width) || null,
      height: int((video ?? image)?.height) || int(item.original_height) || null,
      durationSeconds: isVideo ? num(item.video_duration) ?? dashDuration(item.video_dash_manifest) : null,
      altText: str(item.accessibility_caption),
      raw: carousel.length ? item : null, // single-media posts already keep the whole object on the post
    };
  });
}

/** The version with the most pixels; the list is not reliably sorted and includes square crops. First wins ties. */
export function largest(versions: unknown[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestArea = -1;
  for (const version of versions.map(obj)) {
    if (!version || typeof version.url !== 'string') continue;
    const area = (int(version.width) ?? 0) * (int(version.height) ?? 0);
    if (area > bestArea) {
      best = version;
      bestArea = area;
    }
  }
  return best;
}

function postType(m: Record<string, unknown>): PostType {
  if (m.media_type === 8) return 'carousel';
  if (m.product_type === 'clips' || m.media_type === 2) return 'reel'; // web video posts have been Reels since 2022
  if (m.media_type === 1) return 'image';
  return 'unknown';
}

/**
 * Hashtags and mentions as written in the caption, lowercased and de-duplicated in order.
 * Hashtags accept any script (Arabic, CJK, accented Latin); mentions use Instagram's username alphabet.
 */
export function captionEntities(caption: string | null): { hashtags: string[]; mentions: string[] } {
  if (!caption) return { hashtags: [], mentions: [] };
  const unique = (values: string[]): string[] => [...new Set(values.map((v) => v.toLowerCase()))];
  const hashtags = [...caption.matchAll(/(?:^|[^\p{L}\p{N}_&/])#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]!).filter((tag) => !/^\d+$/.test(tag));
  const mentions = [...caption.matchAll(/(?:^|[^\p{L}\p{N}_.@/])@([A-Za-z0-9._]{1,30})/gu)]
    .map((m) => m[1]!.replace(/\.+$/, ''))
    .filter((name) => /^[A-Za-z0-9._]{1,30}$/.test(name));
  return { hashtags: unique(hashtags), mentions: unique(mentions) };
}

/** Reads mediaPresentationDuration="PT1M4.5S" from a DASH manifest string. */
export function dashDuration(manifest: unknown): number | null {
  if (typeof manifest !== 'string') return null;
  const match = manifest.match(/mediaPresentationDuration="PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"/);
  if (!match || match[0] === 'mediaPresentationDuration="PT"') return null;
  const [h, m, s] = [match[1], match[2], match[3]].map((v) => Number(v ?? 0));
  return round(h! * 3600 + m! * 60 + s!);
}

function emptyFields(): PostFields {
  return {
    instagramPostId: null, type: 'unknown', productType: null, ownerUsername: null, caption: null, hashtags: [],
    mentions: [], taggedUsers: [], coauthors: [], location: null, publishedAt: null, accessibilityCaption: null,
    likesCount: null, likesHidden: null, commentsCount: null, commentsDisabled: null, viewsCount: null, playsCount: null,
    durationSeconds: null, audioTitle: null, audioArtist: null, audioType: null, thumbnailUrl: null, width: null,
    height: null, carouselCount: null,
  };
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v) : null);
const round = (v: number): number => Math.round(v * 1000) / 1000;

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function safeUrl(value: string | undefined): URL | null {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}
