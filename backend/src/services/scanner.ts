import path from 'node:path';

const EXTENSIONS = new Set([
  'mp3', 'ogg', 'aac', 'm4a', 'flac', 'wav', 'opus', 'wma', 'alac', 'aiff'
]);

const SKIP_SEGMENTS = ['/node_modules/', '/.DS_Store/'];

/**
 * Find every audio file under a root.
 *
 * The pattern deliberately matches everything and the filtering happens below.
 * Bun.Glob accepts `nocase` and `ignore` and then silently ignores them, which
 * is worse than rejecting them: a pattern relying on either would quietly miss
 * files with an upper-case extension.
 */
export async function scanDirectory(rootDir: string): Promise<string[]> {
  const absRoot = path.resolve(rootDir);
  const matches: string[] = [];

  // followSymlinks defaults to false: a symlinked directory is not descended,
  // so a link pointing out of the library cannot pull in stray files.
  for await (const entry of new Bun.Glob('**/*').scan({
    cwd: absRoot,
    absolute: true,
    onlyFiles: true,
    followSymlinks: false
  })) {
    if (SKIP_SEGMENTS.some((segment) => entry.includes(segment))) continue;
    if (!EXTENSIONS.has(path.extname(entry).toLowerCase().slice(1))) continue;
    matches.push(path.resolve(entry));
  }
  return matches;
}
