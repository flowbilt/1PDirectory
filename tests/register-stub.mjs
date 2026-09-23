// Point "@netlify/blobs" at the in-memory stub so functions run without a Netlify account.
import { register } from "node:module";
register("./stub-loader.mjs", import.meta.url);
