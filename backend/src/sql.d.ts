/**
 * `import sql from './x.sql' with { type: 'text' }` — Bun inlines the file's
 * contents as a string, both when running from source and when bundling. This
 * tells tsc the same thing.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
