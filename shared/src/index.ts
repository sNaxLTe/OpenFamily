// ESM/NodeNext convention: relative imports carry the explicit '.js' extension
// so the compiled dist resolves under Node's ESM loader (package "type":
// "module"). Without it, `export * from './constants'` crashes any Node
// runtime import of the package with ERR_MODULE_NOT_FOUND.
export * from './constants.js';
export * from './types.js';
