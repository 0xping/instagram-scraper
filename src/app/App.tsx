import { useEffect, useMemo, useState } from 'react';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { Box, Text, useApp, useInput, usePaste } from 'ink';
import { PasswordInput, Select, TextInput } from '@inkjs/ui';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { checkFfmpeg } from '../frames.js';
import { loadConfig } from '../config.js';
import { saveSettings } from '../env-file.js';
import { postDir } from '../media-files.js';
import { openDataPath, openInstagramUrl } from '../open-path.js';
import { redactLog } from '../logger.js';
import { accountSummary, BrowseView, Footer, Header, HomeView, PostView, usePanelHeight, type BrowsePost } from './Screens.js';
import { useCollector } from './useCollector.js';

type Screen = 'first' | 'home' | 'choose' | 'add' | 'browse' | 'post' | 'export' | 'settings' | 'login' | 'hide' | 'quit';
type TargetAction = 'collect' | 'browse' | 'retry' | 'hide';
type Setting = 'service' | 'key' | 'server' | 'model' | 'comments' | 'fps' | 'headed';
const ADD_ACCOUNT = 'Add a new account…';
const LOCAL_WHISPER = 'http://127.0.0.1:8080/v1';
const WHISPER_MODEL = 'large-v3-turbo';
/** Plain names for the transcription services, and what each one needs saved. */
const SERVICES = [
  { label: 'Off (no transcripts)', value: 'off' },
  { label: 'Groq (free account, online)', value: 'groq' },
  { label: 'Whisper on this computer (free)', value: 'local' },
  { label: 'OpenAI (paid)', value: 'openai' },
  { label: 'Another Whisper server', value: 'custom' },
];
const serviceName = (): string => {
  const provider = process.env.TRANSCRIPTION_PROVIDER?.trim() ?? '';
  if (!provider) return 'off';
  if (provider !== 'custom') return provider;
  return (process.env.TRANSCRIPTION_BASE_URL ?? '').includes('127.0.0.1') ? 'local' : 'custom';
};
const PAGE_SIZE = 12;
type PostAction = 'media' | 'folder' | 'frames' | 'details' | 'instagram' | 'back';

/** Only the actions this post can actually perform: a menu entry that cannot work is not offered. */
function postActions(db: Database.Database, dataDir: string, post: BrowsePost | undefined): Array<{ id: PostAction; label: string }> {
  if (!post) return [{ id: 'back', label: 'Back to posts' }];
  const media = db.prepare(`SELECT local_path FROM media WHERE post_id = ? AND download_status = 'complete'
    AND local_path IS NOT NULL ORDER BY position`).all(post.id) as Array<{ local_path: string }>;
  const frames = (db.prepare('SELECT count(*) AS n FROM reel_frames WHERE post_id = ?').get(post.id) as { n: number }).n;
  const video = post.type === 'reel' || media.some((m) => /\.(mp4|mov)$/i.test(m.local_path));
  const folder = postDir(dataDir, post.owner, post.shortcode);
  return [
    ...(media.length ? [{ id: 'media' as const,
      label: video ? 'Play the video' : media.length > 1 ? `Open the ${media.length} photos` : 'Open the photo' }] : []),
    ...(frames ? [{ id: 'frames' as const, label: `Open the ${frames} video images` }] : []),
    ...(existsSync(folder) ? [{ id: 'folder' as const, label: 'Open this post\u2019s folder' }] : []),
    { id: 'details', label: 'Scroll the details' },
    { id: 'instagram', label: 'Open on Instagram' },
    { id: 'back', label: 'Back to posts' },
  ];
}

function wrap(text: string, width = 44): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line) return [''];
    const parts: string[] = [];
    for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width));
    return parts;
  });
}

function postDetail(db: Database.Database, post: BrowsePost | undefined): string[] {
  if (!post) return ['Choose a post to see its details.'];
  const comments = db.prepare('SELECT username, text FROM comments WHERE post_id = ? ORDER BY likes_count DESC, id LIMIT 5')
    .all(post.id) as Array<{ username: string; text: string }>;
  const transcript = db.prepare('SELECT transcript FROM transcripts WHERE post_id = ? ORDER BY id DESC LIMIT 1')
    .get(post.id) as { transcript: string } | undefined;
  const frames = db.prepare('SELECT count(*) AS n FROM reel_frames WHERE post_id = ?').get(post.id) as { n: number };
  return [
    `${post.type} · ${post.shortcode}`, `Published: ${post.published_at ?? 'unknown'}`,
    `Likes: ${post.likes_count ?? '?'} · Comments: ${post.comments_count ?? '?'} · Views: ${post.views_count ?? '?'}`,
    `Saved video images: ${frames.n}`, '', 'Caption', ...wrap(post.caption || 'No caption saved'), '',
    'Video speech', ...wrap(transcript?.transcript || 'No speech transcript saved'), '',
    'Popular comments', ...comments.flatMap((c) => wrap(`@${c.username}: ${c.text}`)),
  ];
}

export function App({ db, dataDir, envPath, firstRun }: {
  db: Database.Database; dataDir: string; envPath: string; firstRun: boolean;
}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>(firstRun ? 'first' : 'home');
  const [selected, setSelected] = useState<string | null>(null);
  const [homeIndex, setHomeIndex] = useState(0);
  const [targetAction, setTargetAction] = useState<TargetAction>('collect');
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [postIndex, setPostIndex] = useState(0);
  const [postActionIndex, setPostActionIndex] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  const [exportIndex, setExportIndex] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [settingIndex, setSettingIndex] = useState(0);
  const [editing, setEditing] = useState<Setting | null>(null);
  const [draft, setDraft] = useState('');
  const [inputVersion, setInputVersion] = useState(0);
  const [quitAfterStop, setQuitAfterStop] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [pendingService, setPendingService] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const collector = useCollector(db, dataDir, selected);
  const currentConfig = useMemo(() => loadConfig(), [settingsVersion]);
  const settingRows = useMemo<Array<{ id: Setting; label: string; value: string }>>(() => {
    void settingsVersion;
    const service = serviceName();
    const keyName = service === 'openai' ? 'OPENAI_API_KEY' : service === 'groq' ? 'GROQ_API_KEY' : 'TRANSCRIPTION_API_KEY';
    return [
      { id: 'service', label: 'Video speech transcription', value: SERVICES.find((s) => s.value === service)?.label ?? service },
      ...(service === 'groq' || service === 'openai' ? [{ id: 'key' as const,
        label: `${service === 'groq' ? 'Groq' : 'OpenAI'} API key`, value: process.env[keyName]?.trim() ? 'saved' : 'not set' }] : []),
      ...(service === 'local' || service === 'custom' ? [
        { id: 'server' as const, label: 'Whisper server address', value: process.env.TRANSCRIPTION_BASE_URL || 'not set' },
        { id: 'model' as const, label: 'Whisper model', value: process.env.TRANSCRIPTION_MODEL || 'not set' },
      ] : []),
      { id: 'comments', label: 'Comments saved per post', value: String(currentConfig.commentLimit ?? 'all') },
      { id: 'fps', label: 'Images saved per video second', value: (1 / currentConfig.frameInterval).toFixed(2) },
      { id: 'headed', label: 'Show browser while collecting', value: currentConfig.browser.headed ? 'yes' : 'no' },
    ];
  }, [currentConfig, settingsVersion]);
  const ffmpeg = useMemo(() => { try { checkFfmpeg(); return true; } catch { return false; } }, []);
  const chromiumReady = useMemo(() => existsSync(chromium.executablePath()), []);
  const rows = collector.state.competitors;
  const listHeight = Math.max(4, usePanelHeight(8) - 3); // rows a full-height chooser can show
  const homeActions = [
    { id: 'login', label: collector.sessionStatus === 'valid' ? 'Reconnect Instagram' : 'Connect Instagram' },
    { id: 'collect', label: 'Collect posts and media' },
    { id: 'browse', label: 'Review saved posts' },
    { id: 'retry', label: 'Fix failed items' },
    { id: 'export', label: 'Export data' },
    { id: 'hide', label: 'Hide an account' },
    { id: 'settings', label: 'Settings' },
    ...(collector.running ? [{ id: 'stop', label: 'Stop current task' }] : []),
    { id: 'quit', label: 'Quit' },
  ];
  // Collecting and hiding apply to any account; reviewing and fixing only make sense where there is something to
  // review or fix, so accounts without it are left out rather than offered and then found empty.
  const targetRows = targetAction === 'browse' ? rows.filter((row) => row.discovered > 0)
    : targetAction === 'retry' ? rows.filter((row) => row.failed > 0) : rows;
  const choices = targetAction === 'collect'
    ? [ADD_ACCOUNT, 'All accounts', ...targetRows.map((row) => `@${row.username} · ${accountSummary(row)}`)]
    : targetRows.map((row) => `@${row.username}`);
  const exportRows = rows.filter((row) => row.discovered > 0);
  const posts = useMemo(() => {
    if (!selected || (screen !== 'browse' && screen !== 'post')) return [];
    return db.prepare(`SELECT p.id, p.shortcode, p.url, p.type, p.published_at, p.caption, p.likes_count,
      p.comments_count, p.views_count, owner.username AS owner
      FROM posts p JOIN competitors owner ON owner.id = p.competitor_id
      WHERE p.competitor_id = @id OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @id)
      ORDER BY p.published_at IS NULL, p.published_at DESC, p.id LIMIT @limit OFFSET @offset`)
      .all({ id: (db.prepare('SELECT id FROM competitors WHERE username = ?').get(selected) as { id: number }).id,
        limit: PAGE_SIZE, offset: page * PAGE_SIZE }) as BrowsePost[];
  }, [db, selected, page, screen]);
  const post = posts[postIndex];
  const detail = useMemo(() => postDetail(db, post), [db, post]);
  const actions = useMemo(() => postActions(db, dataDir, post), [db, dataDir, post]);

  useEffect(() => {
    if (!collector.state.competitors.some((c) => c.username === selected)) {
      setSelected(collector.state.competitors[0]?.username ?? null);
    }
  }, [collector.state.competitors, selected]);
  useEffect(() => {
    if (collector.sessionStatus === 'checking') void collector.verifySession();
  }, [collector.sessionStatus, collector.verifySession]);
  useEffect(() => {
    if (quitAfterStop && !collector.running) exit();
  }, [quitAfterStop, collector.running, exit]);
  useEffect(() => {
    const signal = (): void => { collector.stop(); setQuitAfterStop(true); };
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    return () => { process.off('SIGINT', signal); process.off('SIGTERM', signal); };
  }, [collector.stop]);

  usePaste((text) => {
    setDraft((value) => `${value} ${text.replace(/[\s,]+/g, ' ')}`.trim());
    setInputVersion((n) => n + 1);
  }, { isActive: screen === 'add' });

  const message = (error: unknown): void => {
    const text = redactLog((error as Error).message);
    collector.log.error(text);
    setNotice(text);
  };
  const goHome = (): void => { setScreen('home'); setEditing(null); setDraft(''); };
  const save = (changes: Record<string, string>): void => {
    try {
      saveSettings(envPath, changes);
      setSettingsVersion((n) => n + 1);
      collector.log.info('Settings saved.');
      setEditing(null);
    } catch (error) { message(error); }
  };
  const open = (path: string | null): void => {
    if (!path) { collector.log.warn('No saved file for this post yet.'); return; }
    void openDataPath(dataDir, path).catch(message);
  };

  useInput((_, key) => {
    if (notice) setNotice(null);
    if (key.escape) {
      if (screen === 'login' && collector.running) collector.stop();
      if (editing) { setEditing(null); return; }
      if (screen === 'post') setScreen('browse');
      else if (screen !== 'home') goHome();
      return;
    }
    if (screen === 'first') {
      if (key.return) goHome();
      return;
    }
    if (screen === 'quit') {
      if (key.upArrow || key.downArrow) setConfirmIndex(1 - confirmIndex);
      else if (key.return) {
        if (confirmIndex === 0) goHome();
        else { collector.stop(); setQuitAfterStop(true); }
      }
      return;
    }
    if (screen === 'hide') {
      if (key.upArrow || key.downArrow) setConfirmIndex(1 - confirmIndex);
      else if (key.return) {
        if (confirmIndex === 1 && selected) collector.hide(selected);
        goHome();
      }
      return;
    }
    if (screen === 'login') return;
    if (screen === 'add' || editing) return;
    if (screen === 'home') {
      if (key.upArrow) setHomeIndex(Math.max(0, homeIndex - 1));
      else if (key.downArrow) setHomeIndex(Math.min(homeActions.length - 1, homeIndex + 1));
      else if (key.return) {
        const action = homeActions[Math.min(homeIndex, homeActions.length - 1)]?.id;
        if (action === 'login') { setScreen('login'); void collector.login().finally(goHome); }
        else if (action === 'add') { setDraft(''); setInputVersion((n) => n + 1); setScreen('add'); }
        else if (action === 'collect' || action === 'browse' || action === 'retry' || action === 'hide') {
          // Collecting opens its own list, which can add an account first; Instagram is only needed to start.
          if (!rows.length && action !== 'collect') { setNotice('Add an account first.'); return; }
          if (action === 'browse' && !rows.some((row) => row.discovered > 0)) { setNotice('No posts saved yet. Choose Collect posts and media first.'); return; }
          if (action === 'retry' && !rows.some((row) => row.failed > 0)) { setNotice('Nothing needs fixing right now.'); return; }
          setTargetAction(action);
          setChoiceIndex(0);
          setScreen('choose');
        } else if (action === 'export') { setExportIndex(0); setScreen('export'); }
        else if (action === 'settings') setScreen('settings');
        else if (action === 'stop') collector.stop();
        else if (action === 'quit') {
          if (collector.running) { setConfirmIndex(0); setScreen('quit'); } else exit();
        }
      }
    } else if (screen === 'choose') {
      if (key.upArrow) setChoiceIndex(Math.max(0, choiceIndex - 1));
      else if (key.downArrow) setChoiceIndex(Math.min(choices.length - 1, choiceIndex + 1));
      else if (key.return) {
        if (targetAction === 'collect' && choiceIndex === 0) { setDraft(''); setInputVersion((n) => n + 1); setScreen('add'); return; }
        if (targetAction === 'collect' && collector.sessionStatus !== 'valid') { setNotice('Connect Instagram before collecting.'); return; }
        if (targetAction === 'collect' && choiceIndex === 1) {
          if (!targetRows.length) { setNotice('Add an account first.'); return; }
          goHome(); void collector.scrape(['--all'], true); return;
        }
        const row = targetRows[targetAction === 'collect' ? choiceIndex - 2 : choiceIndex];
        if (!row) return;
        setSelected(row.username);
        if (targetAction === 'collect') { goHome(); void collector.scrape([row.username], false); }
        else if (targetAction === 'retry') { goHome(); void collector.retry(row.username); }
        else if (targetAction === 'hide') { setConfirmIndex(0); setScreen('hide'); }
        else { setPage(0); setPostIndex(0); setDetailScroll(0); setScreen('browse'); }
      }
    } else if (screen === 'browse') {
      if (key.downArrow) {
        if (postIndex < posts.length - 1) { setPostIndex(postIndex + 1); setDetailScroll(0); }
        else if (posts.length === PAGE_SIZE) { setPage(page + 1); setPostIndex(0); setDetailScroll(0); }
      } else if (key.upArrow) {
        if (postIndex > 0) { setPostIndex(postIndex - 1); setDetailScroll(0); }
        else if (page > 0) { setPage(page - 1); setPostIndex(PAGE_SIZE - 1); setDetailScroll(0); }
      } else if (key.return && post) { setPostActionIndex(0); setScreen('post'); }
    } else if (screen === 'post') {
      if (key.upArrow) setPostActionIndex(Math.max(0, postActionIndex - 1));
      else if (key.downArrow) setPostActionIndex(Math.min(actions.length - 1, postActionIndex + 1));
      else if (key.return && post) {
        const action = actions[Math.min(postActionIndex, actions.length - 1)]?.id;
        if (action === 'media') {
          const media = db.prepare("SELECT local_path FROM media WHERE post_id = ? AND download_status = 'complete' AND local_path IS NOT NULL ORDER BY position LIMIT 1").get(post.id) as { local_path: string } | undefined;
          open(media?.local_path ?? null);
        } else if (action === 'folder') open(postDir(dataDir, post.owner, post.shortcode));
        else if (action === 'frames') {
          const frame = db.prepare('SELECT image_path FROM reel_frames WHERE post_id = ? ORDER BY timestamp_seconds LIMIT 1').get(post.id) as { image_path: string } | undefined;
          open(frame ? dirname(dirname(frame.image_path)) : null);
        } else if (action === 'details') setDetailScroll(detailScroll + 8 >= detail.length ? 0 : detailScroll + 8);
        else if (action === 'instagram') void openInstagramUrl(post.url).catch(message);
        else setScreen('browse');
      }
    } else if (screen === 'export') {
      if (key.upArrow) setExportIndex(Math.max(0, exportIndex - 1));
      else if (key.downArrow) setExportIndex(Math.min(exportRows.length + (collector.lastExport ? 1 : 0), exportIndex + 1));
      else if (key.return) {
        try {
          if (exportIndex > exportRows.length) open(collector.lastExport);
          else if (!exportRows.length) setNotice('Nothing to export yet. Choose Collect posts and media first.');
          else if (exportIndex === 0) collector.exportData(['--all']);
          else collector.exportData([exportRows[exportIndex - 1]!.username]);
        }
        catch (error) { message(error); }
      }
    } else if (screen === 'settings') {
      if (key.upArrow) setSettingIndex(Math.max(0, settingIndex - 1));
      else if (key.downArrow) setSettingIndex(Math.min(settingRows.length - 1, settingIndex + 1));
      else if (key.return) setEditing(settingRows[Math.min(settingIndex, settingRows.length - 1)]!.id);
    }
  });

  const footer = screen === 'first' ? 'Enter to continue'
    : screen === 'add' ? 'Type or paste names · Enter to save · Esc to go back'
      : screen === 'login' ? 'Finish login in the browser · Esc to cancel'
        : '↑↓ choose · Enter to continue · Esc to go back';

  return <Box flexDirection="column" width="100%" height="100%">
    <Header session={collector.sessionStatus} running={collector.running} />
    {screen === 'home' ? <HomeView state={collector.state} selected={selected} logs={collector.logs}
      actions={homeActions.map((action) => action.label)} actionIndex={Math.min(homeIndex, homeActions.length - 1)} /> : null}
    {screen === 'first' ? <Box borderStyle="single" flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>Welcome to Instagram research</Text>
      <Text>1. Connect Instagram in the next screen.</Text>
      <Text>2. Add the accounts you want to track.</Text>
      <Text>3. Choose Collect posts and media.</Text>
      {!chromiumReady || !ffmpeg ? <Text color="yellow">Setup is incomplete. Run Install again before collecting.</Text> : null}
      <Text dimColor>{firstRun ? 'Your local settings are ready.' : 'Your settings are ready.'}</Text>
    </Box> : null}
    {screen === 'choose' ? <Box borderStyle="single" flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>{targetAction === 'collect' ? 'Add an account, or choose what to collect' : targetAction === 'browse' ? 'Which account would you like to review?'
        : targetAction === 'retry' ? 'Which account needs another try?' : 'Which account should be hidden?'}</Text>
      <Text dimColor>Choose with the arrow keys, then press Enter.</Text>
      {choices.slice(Math.max(0, choiceIndex - listHeight + 1), Math.max(0, choiceIndex - listHeight + 1) + listHeight).map((label, i) => {
        const index = Math.max(0, choiceIndex - listHeight + 1) + i;
        return <Text key={label} color={index === choiceIndex ? 'cyan' : undefined} bold={index === choiceIndex}>
          {index === choiceIndex ? '›' : ' '} {label}
        </Text>;
      })}
      {choices.length > listHeight ? <Text dimColor>{choiceIndex + 1} of {choices.length}</Text> : null}
    </Box> : null}
    {screen === 'add' ? <Box borderStyle="single" flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>Add Instagram accounts</Text>
      <Text>Enter usernames or profile links. Separate several with spaces or commas.</Text>
      <Text dimColor>They are saved, and the list reopens so you can collect them.</Text>
      <TextInput key={inputVersion} defaultValue={draft} placeholder="@brand, @another" onChange={setDraft}
        onSubmit={(value) => {
          try {
            collector.add(value);
            setDraft('');
            // Back to the collect list, on the account just added, so it can be collected straight away.
            setChoiceIndex(2);
            setTargetAction('collect');
            setScreen('choose');
          } catch (error) { message(error); }
        }} />
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box> : null}
    {screen === 'browse' && selected ? <BrowseView username={selected} posts={posts} selected={postIndex}
      detail={detail} scroll={detailScroll} page={page} /> : null}
    {screen === 'post' && post ? <PostView detail={detail} scroll={detailScroll} actions={actions.map((a) => a.label)} actionIndex={postActionIndex} /> : null}
    {screen === 'export' ? <Box borderStyle="single" flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>Export saved data</Text>
      {(exportRows.length ? ['Export all accounts', ...exportRows.map((row) => `Export @${row.username}`)] : ['No posts saved yet'])
        .concat(collector.lastExport ? ['Open export folder'] : [])
        .slice(Math.max(0, exportIndex - listHeight + 1), Math.max(0, exportIndex - listHeight + 1) + listHeight)
        .map((label, i) => {
          const index = Math.max(0, exportIndex - listHeight + 1) + i;
          return <Text key={label} color={index === exportIndex ? 'cyan' : undefined} bold={index === exportIndex}>
            {index === exportIndex ? '›' : ' '} {label}
          </Text>;
        })}
      <Text>Files go to {collector.lastExport ?? join(dataDir, 'exports')}</Text>
      <Text dimColor>CSV and JSON include saved data. Photos and videos stay in the data folder.</Text>
      {collector.logs.length ? <Text>{collector.logs.at(-1)}</Text> : null}
    </Box> : null}
    {screen === 'settings' ? <Box borderStyle="single" flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>Settings</Text>
      {settingRows.map((row, i) => <Text key={row.id} color={i === settingIndex ? 'cyan' : undefined} bold={i === settingIndex} wrap="truncate-end">
        {i === settingIndex ? '›' : ' '} {row.label}: {row.value}
      </Text>)}
      <Text> </Text>
      {editing === 'service' ? <Select options={SERVICES} defaultValue={serviceName()} onChange={(choice) => {
        // Everything the choice needs is written together, so a half-configured service is never saved.
        if (choice === 'off') { save({ TRANSCRIPTION_PROVIDER: '' }); return; }
        if (choice === 'local' || choice === 'custom') {
          save({ TRANSCRIPTION_PROVIDER: 'custom',
            TRANSCRIPTION_BASE_URL: choice === 'local' ? LOCAL_WHISPER : process.env.TRANSCRIPTION_BASE_URL?.trim() || LOCAL_WHISPER,
            TRANSCRIPTION_MODEL: process.env.TRANSCRIPTION_MODEL?.trim() || WHISPER_MODEL });
          if (choice === 'custom') setEditing('server');
          return;
        }
        const keyName = choice === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
        if (process.env[keyName]?.trim()) save({ TRANSCRIPTION_PROVIDER: choice });
        else { setPendingService(choice); setEditing('key'); } // ask for the key first, then save both together
      }} /> : null}
      {editing === 'key' ? <PasswordInput placeholder={`Paste the ${(pendingService ?? serviceName()) === 'openai' ? 'OpenAI' : 'Groq'} API key`}
        onSubmit={(value) => {
          const service = pendingService ?? serviceName();
          save({ [service === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY']: value.trim(), TRANSCRIPTION_PROVIDER: service });
          setPendingService(null);
        }} /> : null}
      {editing === 'server' ? <TextInput placeholder={LOCAL_WHISPER} defaultValue={process.env.TRANSCRIPTION_BASE_URL || LOCAL_WHISPER}
        onSubmit={(value) => save({ TRANSCRIPTION_PROVIDER: 'custom', TRANSCRIPTION_BASE_URL: value.trim(),
          TRANSCRIPTION_MODEL: process.env.TRANSCRIPTION_MODEL?.trim() || WHISPER_MODEL })} /> : null}
      {editing === 'model' ? <TextInput placeholder={WHISPER_MODEL} defaultValue={process.env.TRANSCRIPTION_MODEL || WHISPER_MODEL}
        onSubmit={(value) => save({ TRANSCRIPTION_MODEL: value.trim() })} /> : null}
      {editing === 'comments' ? <TextInput placeholder="100 or all" defaultValue={String(currentConfig.commentLimit ?? 'all')}
        onSubmit={(v) => save({ COMMENT_LIMIT: v })} /> : null}
      {editing === 'fps' ? <TextInput placeholder="1" defaultValue={String(1 / currentConfig.frameInterval)}
        onSubmit={(v) => { const fps = Number(v); if (!Number.isFinite(fps) || fps <= 0) message(new Error('Frames per second must be positive')); else save({ FRAME_INTERVAL: String(1 / fps) }); }} /> : null}
      {editing === 'headed' ? <Select options={[{ label: 'yes', value: 'true' }, { label: 'no', value: 'false' }]}
        defaultValue={String(currentConfig.browser.headed)} onChange={(v) => save({ BROWSER_HEADED: v })} /> : null}
      {editing === 'service' || editing === 'key' || editing === 'server' || editing === 'model'
        ? <Text dimColor>Whisper on this computer needs the whisper.cpp server running. See the README.</Text> : null}
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box> : null}
    {screen === 'login' ? <Box borderStyle="single" paddingX={1}><Text>Sign in to Instagram in the browser window. Return here when it finishes.</Text></Box> : null}
    {screen === 'hide' || screen === 'quit' ? <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>{screen === 'hide' ? `Hide @${selected}?` : 'Collection is still running'}</Text>
      <Text>{screen === 'hide' ? 'Saved posts stay on this computer. Add this account again to restore it.' : 'Stopping waits for the current item to finish.'}</Text>
      {(screen === 'hide' ? ['Keep account', 'Hide account'] : ['Keep working', 'Stop and quit']).map((label, i) =>
        <Text key={label} color={i === confirmIndex ? 'cyan' : undefined}>{i === confirmIndex ? '›' : ' '} {label}</Text>)}
    </Box> : null}
    <Footer keys={notice ?? footer} error={Boolean(notice)} />
  </Box>;
}
