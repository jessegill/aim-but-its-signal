/** Vite resolves an image import to the URL of the emitted (or inlined) asset. */
declare module '*.png' {
  const url: string;
  export default url;
}
