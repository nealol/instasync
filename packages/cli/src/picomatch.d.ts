declare module "picomatch" {
  interface Options {
    dot?: boolean;
  }

  const picomatch: {
    isMatch(input: string, glob: string, options?: Options): boolean;
  };

  export default picomatch;
}
