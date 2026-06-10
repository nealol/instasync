// esbuild's `dataurl` loader turns a `*.wasm` import into a `data:...;base64,…`
// URL string. tsc needs this ambient declaration to typecheck wasmBinary.ts.
declare module "*.wasm" {
	const dataUrl: string;
	export default dataUrl;
}
