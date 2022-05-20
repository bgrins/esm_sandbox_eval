// deno test --allow-net test.js --watch

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.137.0/testing/asserts.ts";
import { execInSandbox } from "./mod.js";

Deno.test("basics", async () => {
  assertEquals(await execInSandbox("return 1+1"), 2);
  assertEquals(
    await execInSandbox("return a+b", {
      exposed: {
        a: 3,
        b: 4,
      },
    }),
    7
  );
  assertEquals(
    await execInSandbox("export default function({a, b}) { return a+b }", {
      exposed: {
        a: 3,
        b: 4,
      },
    }),
    7
  );

  await execInSandbox(
    `console.log("Log works"); console.error("Error works"); `
  );

  // Define functions using header
  assertEquals(
    await execInSandbox("return a(b)", {
      exposed: {
        b: 5,
      },
      header: `function a(num) { return num * 2; }`,
    }),
    10
  );

  // Define functions using header
  assertEquals(
    await execInSandbox(
      `
  export default function({b}) {
    return a(b);
  }`,
      {
        exposed: {
          b: 6,
        },
        header: `function a(num) { return num * 2; }`,
      }
    ),
    12
  );

  assertEquals(
    await execInSandbox(
      `
    import jmespath from "https://cdn.skypack.dev/jmespath";
    console.log(jmespath);
    console.log(jmespath.search({a: 100}, "a"));
    export default function({input, options}) {
      return jmespath.search(input, options);
    }
    `,
      {
        exposed: {
          input: { a: 4 },
          options: "a",
        },
        importMap: {},
      }
    ),
    4
  );

  let threw = false;
  try {
    await execInSandbox("invalid syntax");
  } catch (e) {
    threw = true;
  }

  assert(threw, "invalid syntax should throw");

  threw = false;
  try {
    await execInSandbox(
      `
      import jmespath from "https://cdn.skypack.dev/jmespath";
      export default function() { return 1; }
    `,
      {
        allowRemoteModuleLoads: false,
      }
    );
  } catch (e) {
    threw = true;
  }
  assert(threw, "allowRemoteModuleLoads=false should throw");

  assertEquals(
    await execInSandbox(
      `
    import jmespath from "https://cdn.skypack.dev/jmespath";
    import * as marked from "https://esm.sh/marked/";
    export default function({input, options}) { return jmespath.search(marked.lexer(input), "[0].tokens"); }
    `,
      {
        exposed: {
          input: "# hello",
          options: "a",
        },
        importMap: {},
      }
    ),
    [
      {
        raw: "hello",
        text: "hello",
        type: "text",
      },
    ]
  );
  assertEquals(
    await execInSandbox(
      `
    import jmespath from "https://cdn.skypack.dev/jmespath";
    import * as marked from "https://esm.sh/marked/";
    export function custom({input, options}) { return jmespath.search(marked.lexer(input), "[0].tokens"); }
    `,
      {
        entrypoint: "custom",
        exposed: {
          input: "# hello",
          options: "a",
        },
        importMap: {},
      }
    ),
    [
      {
        raw: "hello",
        text: "hello",
        type: "text",
      },
    ]
  );

  threw = false;
  assertEquals(
    await execInSandbox(
      `
    import foo from "foo.js";
    export default function() { return foo; }
  `,
      {
        importMap: {
          "foo.js": `import bar from "bar.js"; export default "foo";`,
          "bar.js": `import foo from "foo.js"; export default "bar";`,
        },
        verbose: true,
      }
    ),
    "foo"
  );
});
