import { glob } from 'glob';
import path from 'node:path';

const EXTENSIONS = [
  'mp3', 'ogg', 'aac', 'm4a', 'flac', 'wav', 'opus', 'wma', 'alac', 'aiff'
];

export async function scanDirectory(rootDir: string): Promise<string[]> {
  const absRoot = path.resolve(rootDir);
  const pattern = `**/*.{${EXTENSIONS.join(',')}}`;
  const matches = await glob(pattern, {
    cwd: absRoot,
    absolute: true,
    nocase: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.DS_Store/**'],
    follow: false
  });
  return matches.map((p) => path.resolve(p));
}
