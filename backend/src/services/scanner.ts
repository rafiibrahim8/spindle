import path from 'node:path';

const EXTENSIONS = new Set([
  'mp3', 'ogg', 'aac', 'm4a', 'flac', 'wav', 'opus', 'wma', 'alac', 'aiff'
]);

const SKIP_SEGMENTS = ['/node_modules/', '/.DS_Store/'];

/**
 * Find every audio file under a root.
 *
 * The old `glob` call did the filtering itself, with `nocase` for extensions
 * and an `ignore` list. Bun.Glob accepts both options and then ignores them —
 * silently, which is worse than rejecting them — so the pattern matches
 * everything and the filtering happens here. Verified to return the same file
 * set as the previous implementation.
 */
export async function scanDirectory(rootDir: string): Promise<string[]> {
  const absRoot = path.resolve(rootDir);
  const matches: string[] = [];

  // followSymlinks defaults to false, matching the old `follow: false`.
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
