// import { bundle, transpile } from "https://deno.land/x/emit/mod.ts";
import { bundle, transpile } from "https://deno.land/x/emit@0.28.0/mod.ts";;
const result = await bundle(
  new URL("./mod.js", import.meta.url), {
  type: "classic",
  }
);

const { code } = result;
console.log(code.length);

Deno.writeTextFileSync("./mod.bundle.js", code);