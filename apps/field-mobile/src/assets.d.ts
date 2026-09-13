/** Bundled images resolve to an asset reference Metro understands, not a URL string. */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}
