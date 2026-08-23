/**
 * Optional peer dependency declarations.
 *
 * `node-llama-cpp` is an optional peer (local embeddings); it is not
 * installed in every environment. The loader in
 * src/core/store/embedding.ts imports it lazily and degrades gracefully
 * when unavailable, so an `any` module declaration is sufficient here.
 */
declare module "node-llama-cpp";
