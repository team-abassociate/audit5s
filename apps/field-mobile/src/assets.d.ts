/** Bundled images resolve to an asset reference Metro understands, not a URL string. */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}

/** A file's text, through Vite's `?raw` (tests only; Metro never sees these imports). */
declare module '*.css?raw' {
  const text: string;
  export default text;
}
