import { Box, Text, useStdout } from 'ink';
import { ProgressBar, Spinner } from '@inkjs/ui';
import type { StatusRow } from '../batch.js';
import type { DashboardState } from './useCollector.js';

/** Rows the panels may use: everything except the header, footer and message strip. */
export function usePanelHeight(reserved = 9): number {
  const { stdout } = useStdout();
  return Math.max(8, (stdout.rows || 24) - reserved);
}

const stageNames: Record<string, string> = {
  session: 'Instagram connection', profile: 'Account details', discovery: 'Find posts',
  metadata: 'Post details', media: 'Photos', reels: 'Videos', frames: 'Video images',
  transcripts: 'Video speech', comments: 'Comments',
};

export function Header({ session, running }: {
  session: string; running: string | null;
}) {
  return <Box borderStyle="round" paddingX={1} justifyContent="space-between">
    <Text bold color="cyan">INSTAGRAM RESEARCH</Text>
    <Text color={session === 'valid' ? 'green' : 'yellow'}>Instagram: {session === 'valid' ? 'connected' : session === 'checking' ? 'checking' : 'login needed'}</Text>
    {running ? <Spinner label="Working" /> : null}
  </Box>;
}

export function Footer({ keys, error = false }: { keys: string; error?: boolean }) {
  return <Box borderStyle="single" paddingX={1}><Text color={error ? 'yellow' : 'cyan'} wrap={error ? 'truncate-end' : undefined}>{keys}</Text></Box>;
}

export function HomeView({ state, selected, logs, actions, actionIndex }: {
  state: DashboardState; selected: string | null; logs: string[]; actions: string[]; actionIndex: number;
}) {
  const height = usePanelHeight(11);
  const rows = state.competitors;
  // The activity block below needs about eight lines; the rest of the panel lists accounts.
  const listed = Math.max(3, height - 9);
  let stages: Record<string, { status: string; detail?: string }> = {};
  try { stages = JSON.parse(state.job?.stages_json ?? '{}') as typeof stages; } catch { /* an interrupted legacy job may have bad JSON */ }
  const progress = state.subJob && state.subJob.status === 'running' && state.subJob.total_items
    ? Math.min(100, Math.round(state.subJob.processed_items / state.subJob.total_items * 100))
    : state.job?.total_items ? Math.min(100, Math.round(state.job.processed_items / state.job.total_items * 100)) : 0;
  return <>
    <Box flexDirection="row" height={height}>
      <Box borderStyle="single" flexDirection="column" width="42%" paddingX={1}>
        <Text bold>What would you like to do?</Text>
        {actions.map((label, i) => <Text key={label} color={i === actionIndex ? 'cyan' : undefined} bold={i === actionIndex} wrap="truncate-end">
          {i === actionIndex ? '›' : ' '} {label}
        </Text>)}
      </Box>
      <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1}>
        <Text bold>Accounts ({rows.length})</Text>
        {rows.length === 0 ? <Text>Add an Instagram account to track.</Text> : rows.slice(0, listed).map((r: StatusRow) =>
          <Text key={r.username} wrap="truncate-end">@{r.username} · {r.failed ? `${r.failed} need attention` : r.discovered ? `${r.discovered} posts saved` : 'Not collected yet'}</Text>)}
        {rows.length > listed ? <Text dimColor>and {rows.length - listed} more</Text> : null}
        <Text> </Text>
        <Text bold>{selected ? `Latest activity · @${selected}` : 'Latest activity'}</Text>
        {state.job ? <>
          <Text>{state.job.status === 'running' ? 'Collecting' : state.job.status === 'complete' ? 'Complete' : 'Needs attention'} · {stageNames[state.job.current_stage ?? ''] ?? 'Waiting'}</Text>
          {Object.entries(stageNames).filter(([name]) => stages[name]?.status === 'failed' || stages[name]?.status === 'blocked').slice(0, 2).map(([name, label]) =>
            <Text key={name} color="yellow" wrap="truncate-end">Check {label.toLowerCase()}</Text>)}
          <ProgressBar value={progress} />
          {state.subJob?.status === 'running' ? <Text>{state.subJob.processed_items} of {state.subJob.total_items ?? '?'} items done</Text> : null}
        </> : state.totals ? <>
          <Text>{state.totals.posts} posts saved · {state.totals.reels} videos</Text>
          <Text>{state.totals.mediaComplete} media files saved</Text>
        </> : <Text dimColor>Collection progress will appear here.</Text>}
      </Box>
    </Box>
    <Box borderStyle="single" flexDirection="column" paddingX={1} height={5}>
      <Text bold>Latest messages</Text>
      {logs.length ? logs.slice(-2).map((line, i) => <Text key={i} wrap="truncate-end">{line}</Text>)
        : <Text dimColor>Messages appear here after you start.</Text>}
    </Box>
  </>;
}

export interface BrowsePost {
  id: number;
  shortcode: string;
  url: string;
  type: string;
  published_at: string | null;
  caption: string | null;
  likes_count: number | null;
  comments_count: number | null;
  views_count: number | null;
  owner: string;
}

export function BrowseView({ username, posts, selected, detail, scroll, page }: {
  username: string; posts: BrowsePost[]; selected: number;
  detail: string[]; scroll: number; page: number;
}) {
  const height = usePanelHeight(6);
  return <Box flexDirection="row" height={height}>
    <Box borderStyle="single" flexDirection="column" width="48%" paddingX={1}>
      <Text bold>Posts from @{username} · page {page + 1}</Text>
      {posts.length ? posts.map((post, i) => <Text key={post.id} color={i === selected ? 'cyan' : undefined} wrap="truncate-end">
        {i === selected ? '›' : ' '} {post.type} {post.published_at?.slice(0, 10) ?? 'undated'} {post.shortcode}
        {'  '}♥{post.likes_count ?? '?'} 💬{post.comments_count ?? '?'} ▶{post.views_count ?? '?'}
        {'  '}{post.caption?.replace(/\s+/g, ' ').slice(0, 28) ?? ''}
      </Text>) : <Text dimColor>No posts saved yet. Collect this account first.</Text>}
    </Box>
    <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold>Preview · {scroll + 1}-{Math.min(detail.length, scroll + height - 3)}/{detail.length}</Text>
      {detail.slice(scroll, scroll + height - 3).map((line, i) => <Text key={i} wrap="truncate-end">{line || ' '}</Text>)}
    </Box>
  </Box>;
}

export function PostView({ detail, scroll, actions, actionIndex }: {
  detail: string[]; scroll: number; actions: string[]; actionIndex: number;
}) {
  const height = Math.max(5, usePanelHeight(6) - actions.length - 5);
  return <Box flexDirection="column">
    <Box borderStyle="single" flexDirection="column" paddingX={1} height={height + 2}>
      <Text bold>Post details · lines {scroll + 1}-{Math.min(detail.length, scroll + height)} of {detail.length}</Text>
      {detail.slice(scroll, scroll + height - 1).map((line, i) => <Text key={i} wrap="truncate-end">{line || ' '}</Text>)}
    </Box>
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>Choose an action</Text>
      {actions.map((label, i) => <Text key={label} color={i === actionIndex ? 'cyan' : undefined} bold={i === actionIndex}>
        {i === actionIndex ? '›' : ' '} {label}
      </Text>)}
    </Box>
  </Box>;
}
