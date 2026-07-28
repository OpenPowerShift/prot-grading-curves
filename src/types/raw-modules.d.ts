/** Vite's `?raw` import suffix yields the file's text. */
declare module '*.tc?raw' {
  const content: string;
  export default content;
}
