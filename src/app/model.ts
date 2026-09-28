import { normalizeUsername } from '../competitors.js';

/** A spreadsheet column that holds the accounts: `username`, `Instagram`, `Profile URL`, … */
const ACCOUNT_COLUMN = /^(user(name)?|account|handle|instagram|ig|profile|profileurl|url|link)s?$/i;

/**
 * Usernames from pasted text or an imported file: a .txt with one per line (or any spacing, `#` comments allowed),
 * or a .csv, where a header naming the account column means only that column is read. Anything that is not a
 * username or profile link is returned in `skipped` rather than failing the whole list.
 */
export function parseAccountList(text: string): { usernames: string[]; skipped: string[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  const rows = lines.map((line) => line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1').trim()));
  const column = rows[0]?.findIndex((cell) => ACCOUNT_COLUMN.test(cell.replace(/[\s_-]/g, ''))) ?? -1;
  const cells = column >= 0 ? rows.slice(1).map((row) => row[column] ?? '') : rows.flat().flatMap((cell) => cell.split(/\s+/));
  const usernames = new Set<string>();
  const skipped: string[] = [];
  for (const cell of cells) {
    if (!cell) continue;
    try {
      const name = normalizeUsername(cell);
      if (name) usernames.add(name);
    } catch {
      skipped.push(cell);
    }
  }
  return { usernames: [...usernames], skipped };
}
