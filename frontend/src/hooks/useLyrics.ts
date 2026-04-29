import { useQuery } from '@tanstack/solid-query';
import { createMemo } from 'solid-js';
import { api } from '../api/client';

export interface ParsedLyricLine {
  time: number;
  text: string;
}

export function parseLrc(lrc?: string | null): ParsedLyricLine[] {
  if (!lrc) return [];
  const parsed: ParsedLyricLine[] = [];
  const timestamp = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const line of lrc.split('\n')) {
    const matches = [...line.matchAll(timestamp)];
    if (!matches.length) continue;
    const text = line.replace(timestamp, '').trim();
    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] || '0';
      const divisor = fraction.length === 3 ? 1000 : fraction.length === 2 ? 100 : 10;
      parsed.push({
        time: minutes * 60 + seconds + Number(fraction) / divisor,
        text
      });
    }
  }
  return parsed.sort((a, b) => a.time - b.time);
}

export function activeLyricIndex(lyrics: ParsedLyricLine[], currentTime: number): number {
  if (!lyrics.length) return -1;
  let index = 0;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= currentTime) index = i;
    else break;
  }
  return index;
}

export function useLyrics(trackId: () => number | undefined) {
  const query = useQuery(() => ({
    queryKey: ['lyrics', trackId()],
    queryFn: () => api.getLyrics(trackId()!),
    enabled: typeof trackId() === 'number'
  }));
  const syncedLines = createMemo(() => parseLrc(query.data?.syncedLrc));
  const unsyncedText = createMemo(() => query.data?.unsyncedText || '');
  return { query, syncedLines, unsyncedText };
}
