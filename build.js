
// Rebuild the worker bundle, and serve it. Run with this for file watching:
// deno run -A --watch build.js --serve

import { bundle, transpile } from "https://deno.land/x/emit@0.28.0/mod.ts";
const result = await bundle(new URL("./mod.js", import.meta.url), {
  type: "classic",
});

// This sets up the dependency for file watching
import * as mod from "./mod.js";

const { code } = result;
console.log(code.length);

Deno.writeTextFileSync("./esm_sandbox_worker.bundle.js", code);

import { serveDir } from "https://deno.land/std@0.202.0/http/file_server.ts";
const port = 8000;
if (Deno.args[0] === "--serve") {
  console.log(`Serving on http://localhost:${port}`);
  Deno.serve((req) => {
    const pathname = new URL(req.url).pathname;
    return serveDir(req, {
      fsRoot: ".",
    });
  });
}
