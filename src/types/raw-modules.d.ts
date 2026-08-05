/** Vite's `?raw` import suffix yields the file's text. */
declare module '*.ptc?raw' {
  const content: string;
  export default content;
}
