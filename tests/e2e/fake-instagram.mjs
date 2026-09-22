/* global URL, URLSearchParams, Buffer */
// A local stand-in for instagram.com, its media CDN and the OpenAI transcription endpoint, used by the
// end-to-end validation (tests/e2e/validate.mjs). The collector's Chromium is routed here by cli-child.mjs, so the
// real CLI runs unchanged. Pages mirror the shapes the extractors read: inline `script[type="application/json"]`
// media objects, a GraphQL user timeline, grid links, and signed CDN URLs with an `oe` expiry.

import { createServer } from 'node:http';

const HOUR = 3600;

/** Mutable world the validation script edits between runs. */
export function createState(username) {
  return {
    username,
    home: 'ok', // 'ok' | 'logged_out' | 'challenge'
    followers: 1234,
    /** Signed-URL generation; bumping it rotates every CDN URL, like Instagram does on each page load. */
    urlGeneration: 1,
    posts: [],
    /** Post codes whose page answers HTTP 500 until released. */
    brokenPages: new Set(),
    /** CDN files that answer HTTP 500 until released. */
    brokenFiles: new Set(),
    /** Post codes served without the JSON media object (only OpenGraph meta), like a degraded page. */
    degraded: new Set(),
    hits: {},
    transcriptions: 0,
    /** Called on every request with the path; the validator uses it to interrupt the CLI at a chosen moment. */
    onHit: null,
  };
}

export function hitCount(state, prefix) {
  return Object.entries(state.hits).filter(([path]) => path.startsWith(prefix)).reduce((n, [, c]) => n + c, 0);
}

/**
 * Comments as the live post page embeds them (captured September 2026): a media-id comments connection, nested
 * deep in a `require`/`__bbox` wrapper, with neither the shortcode nor the media id anywhere in the block.
 */
function commentNodes(post) {
  const node = (c, parent = null) => ({
    user: { pk: '1', username: c.user, is_verified: false }, pk: c.id, text: c.text, created_at: c.at, comment_like_count: c.likes,
    child_comment_count: c.replies?.length ?? 0, parent_comment_id: parent, __typename: 'XDTCommentDict',
  });
  return post.comments.map((c) => [node(c), ...(c.replies ?? []).map((r) => node(r, c.id))]);
}
const connection = (groups, hasNext) => ({ data: { xdt_api__v1__media__media_id__comments__connection: {
  edges: groups.flat().map((n) => ({ node: n, cursor: '' })), page_info: { end_cursor: hasNext ? 'next' : null, has_next_page: hasNext },
} } });

/** First page inline; with `pageSize`, the rest arrives from /api/graphql when the comment panel is scrolled. */
function commentsBlock(post) {
  const groups = commentNodes(post);
  const first = post.pageSize ? groups.slice(0, post.pageSize) : groups;
  const result = connection(first, first.length < groups.length);
  return { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_q', { __bbox: { complete: true, result } }]]] } }]]] };
}

/** The 2026 comment panel: a scrollable div (no lists) whose bottom triggers PolarisPostCommentsPaginationQuery. */
function commentPanel(post) {
  if (!post.pageSize) return '';
  const vars = encodeURIComponent(JSON.stringify({ after: 'next', first: 10, media_id: post.pk }));
  return `<div id="panel" style="overflow-y:auto;height:80px"><div style="height:400px"><time datetime="2026-01-01T00:00:00.000Z"></time></div></div>
<script>let asked = false; document.getElementById('panel').addEventListener('scroll', (e) => {
  const el = e.target; if (asked || el.scrollTop + el.clientHeight < el.scrollHeight - 2) return; asked = true;
  fetch('/api/graphql', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fb_api_req_friendly_name=PolarisPostCommentsPaginationQuery&variables=${vars}' });
});</script>`;
}

function mediaObject(state, post, base) {
  const url = (file) => `${base}/cdn/${file}?oe=${(Math.floor(Date.now() / 1000) + 48 * HOUR).toString(16)}&_nc_gen=${state.urlGeneration}`;
  const image = (file) => ({ image_versions2: { candidates: [{ url: url(file), width: 320, height: 320 }, { url: url(`small-${file}`), width: 150, height: 150 }] } });
  const common = {
    code: post.code, pk: post.pk, id: `${post.pk}_42`, taken_at: post.takenAt, user: { username: state.username },
    caption: { text: post.caption }, like_count: post.likes, comment_count: post.comments.length,
    like_and_view_counts_disabled: false, comments_disabled: post.commentsDisabled ?? false,
    location: post.location ? { name: post.location } : null,
    usertags: { in: (post.tagged ?? []).map((username) => ({ user: { username } })) },
    original_width: 1080, original_height: post.kind === 'reel' ? 1920 : 1080,
  };
  if (post.kind === 'image') return { ...common, media_type: 1, product_type: 'feed', ...image(post.files[0]) };
  if (post.kind === 'carousel') {
    return {
      ...common, media_type: 8, product_type: 'carousel_container', carousel_media_count: post.files.length,
      carousel_media: post.files.map((file, i) => file.endsWith('.mp4')
        ? { pk: `${post.pk}${i}`, media_type: 2, original_width: 360, original_height: 640, video_versions: [{ url: url(file), width: 360, height: 640 }], ...image(`${file}.jpg`) }
        : { pk: `${post.pk}${i}`, media_type: 1, original_width: 320, original_height: 320, accessibility_caption: `slide ${i + 1}`, ...image(file) }),
    };
  }
  return {
    ...common, media_type: 2, product_type: 'clips', view_count: post.views, ig_play_count: post.plays,
    clips_metadata: { audio_type: 'original_sounds', original_sound_info: { original_audio_title: 'Original audio', ig_artist: { username: state.username } } },
    video_dash_manifest: `<MPD mediaPresentationDuration="PT${post.duration}S">`,
    video_versions: [{ url: url(post.files[0]), width: 360, height: 640 }], ...image(`${post.files[0]}.jpg`),
  };
}

const html = (head, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Inline JSON as Instagram embeds it; `<` is escaped so captions cannot close the script tag.
const jsonScript = (value) => `<script type="application/json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;

function profilePage(state, base) {
  const visible = state.posts.filter((p) => !p.hidden);
  const user = {
    username: state.username, full_name: 'E2E Brand', biography: 'Validation fixture', follower_count: state.followers,
    following_count: 12, media_count: visible.length, is_private: false, is_verified: false, category: 'Clothing',
    external_url: 'https://example.com/shop', profile_pic_url_hd: `${base}/cdn/avatar.jpg`,
  };
  const grid = visible.map((p) => `<a href="/${p.kind === 'reel' ? 'reel' : 'p'}/${p.code}/">${p.code}</a>`).join('');
  return html(
    `<title>E2E Brand (@${state.username})</title><meta property="og:type" content="profile">`,
    `<main><header><img alt="${state.username}'s profile picture" src="${base}/cdn/avatar.jpg"><h2>${state.username}</h2></header><div>${grid}</div></main>` +
      jsonScript({ data: { user } }) +
      `<script>fetch('/graphql/query', { method: 'POST', body: 'timeline' });</script>`,
  );
}

function timeline(state) {
  const edges = state.posts.filter((p) => !p.hidden).map((p) => ({
    node: { code: p.code, media_type: p.kind === 'image' ? 1 : p.kind === 'carousel' ? 8 : 2, product_type: p.kind === 'reel' ? 'clips' : 'feed' },
  }));
  return { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges, page_info: { has_next_page: false } } } };
}

function postPage(state, post, base) {
  const ogUrl = `https://www.instagram.com/${state.username}/${post.kind === 'reel' ? 'reel' : 'p'}/${post.code}/`;
  const head = `<title>${esc(post.caption.slice(0, 20))} | Instagram</title><meta property="og:type" content="article">` +
    `<meta property="og:url" content="${ogUrl}"><meta property="og:title" content="E2E Brand on Instagram: &quot;${esc(post.caption)}&quot;">`;
  if (state.degraded.has(post.code)) return html(head, `<main><article><div>Log in to see more</div></article></main>`);
  const media = mediaObject(state, post, base);
  return html(head, `<main><article><h1>${esc(post.caption)}</h1><time datetime="${new Date(post.takenAt * 1000).toISOString()}"></time>${commentPanel(post)}</article></main>` +
    jsonScript({ require: [{ xdt_api__v1__media__shortcode__web_info: { items: [media] } }] }) + (post.comments.length ? jsonScript(commentsBlock(post)) : ''));
}

/** Starts the server. `files` maps CDN file names to their bytes. */
export async function startFakeInstagram(state, files) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    state.hits[pathname] = (state.hits[pathname] ?? 0) + 1;
    state.onHit?.(pathname, state.hits[pathname]);
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body); };

    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('latin1'); });
    req.on('end', () => {
      if (pathname === '/') {
        if (state.home === 'logged_out') return send(200, 'text/html', html('<title>Login • Instagram</title>', '<main><form><input name="username"><input name="password" type="password"></form></main>'));
        if (state.home === 'challenge') return send(200, 'text/html', html('<title>Instagram</title>', '<main><iframe src="/recaptcha/api2/anchor"></iframe></main>'));
        return send(200, 'text/html', html('<title>Instagram</title>', '<main><h2>Home</h2></main>'));
      }
      if (pathname === `/${state.username}/`) return send(200, 'text/html', profilePage(state, base));
      if (pathname === '/graphql/query') return send(200, 'application/json', JSON.stringify(timeline(state)));
      if (pathname === '/api/graphql') {
        const vars = JSON.parse(new URLSearchParams(body).get('variables') ?? '{}');
        const post = state.posts.find((p) => p.pk === vars.media_id && p.pageSize);
        return send(200, 'application/json', JSON.stringify(post ? connection(commentNodes(post).slice(post.pageSize), false) : { data: {} }));
      }
      const postMatch = pathname.match(/^\/(?:p|reel)\/([A-Za-z0-9_-]+)\/$/);
      if (postMatch) {
        const post = state.posts.find((p) => p.code === postMatch[1]);
        if (!post || post.deleted) return send(404, 'text/html', html("<title>Page not found • Instagram</title>", "<main><h2>Sorry, this page isn't available.</h2></main>"));
        if (state.brokenPages.has(post.code)) return send(500, 'text/html', html('<title>Error</title>', '<main>Server error</main>'));
        return send(200, 'text/html', postPage(state, post, base));
      }
      const cdn = pathname.match(/^\/cdn\/(.+)$/);
      if (cdn) {
        const name = decodeURIComponent(cdn[1]);
        if (state.brokenFiles.has(name)) return send(500, 'text/plain', 'upstream error');
        const bytes = files[name] ?? files[name.replace(/^small-/, '')] ?? (name.endsWith('.jpg') ? files['fallback.jpg'] : undefined);
        if (!bytes) return send(404, 'text/plain', 'not found');
        res.writeHead(200, { 'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'content-length': bytes.length });
        return res.end(bytes);
      }
      if (pathname === '/openai/v1/audio/transcriptions' && req.method === 'POST') {
        state.transcriptions += 1;
        if (!/name="file"/.test(body) || !/name="model"/.test(body)) return send(400, 'application/json', '{"error":"missing file"}');
        return send(200, 'application/json', JSON.stringify({ text: 'Hello from the validation reel.', language: 'english', segments: [{ start: 0, end: 2.5, text: 'Hello from the validation reel.' }] }));
      }
      send(404, 'text/plain', 'not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
