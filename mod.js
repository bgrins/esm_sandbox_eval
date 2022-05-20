import quickjs from "./build/quickjs-module.js";
import esprima from "https://esm.sh/esprima";

export { quickjs };

const MEMORY_LIMIT = 1024 * 1024 * 32;
const MAX_INTERRUPTS = 1024;

function parseScript(script) {
  // We expect to fail if there's an import/export:
  try {
    let parsed = esprima.parseScript(script);
    return {
      isModule: false,
      parsed,
    };
  } catch (e) {}
  try {
    let parsed = esprima.parseModule(script);
    return {
      isModule: true,
      parsed,
    };
  } catch (e) {}

  throw new Error("Unable to parse script");
}

function isValidHttpUrl(string, base) {
  let url;

  try {
    url = new URL(string, base);
  } catch (_) {
    return false;
  }

  return url.protocol === "http:" || url.protocol === "https:";
}

async function getNewContextWithGlobals({
  exposed,
  importMap,
  verbose,
  allowRemoteModuleLoads,
  isModule,
}) {
  const qjs = await quickjs.newQuickJSAsyncWASMModule();
  const runtime = qjs.newRuntime();

  runtime.setMemoryLimit(MEMORY_LIMIT);
  let interruptCycles = 0;
  runtime.setInterruptHandler(() => ++interruptCycles > MAX_INTERRUPTS);

  runtime.setModuleLoader(
    async (moduleName) => {
      if (verbose) {
        console.log(
          `Loading module by name ${moduleName}. Is HTTP url? ${isValidHttpUrl(
            moduleName
          )}. Is in importMap? ${!!importMap[moduleName]}`
        );
      }
      if (importMap[moduleName]) {
        return importMap[moduleName];
      }

      if (!allowRemoteModuleLoads) {
        throw new Error(
          "Attempting to load a remote module and allowRemoteModuleLoads is false"
        );
      }
      if (isValidHttpUrl(moduleName)) {
        let url = new URL(moduleName);
        let resp = await fetch(url);
        let text = await resp.text();
        return text;
      }

      throw new Error("Can't find module " + moduleName);
    },
    (baseModuleName, moduleNameRequest) => {
      if (verbose) {
        console.log(
          `Module resolver: ${baseModuleName} - ${moduleNameRequest}`
        );
      }
      if (isValidHttpUrl(moduleNameRequest, baseModuleName)) {
        return new URL(moduleNameRequest, baseModuleName).toString();
      }
      return moduleNameRequest;
    }
  );

  const vm = runtime.newContext();

  // For a module pass an options argument into a function.
  // For an inline script set each key as a global
  if (isModule) {
    const json =
      typeof exposed === "undefined" ? "undefined" : JSON.stringify(exposed);
    vm.evalCode(`const __exposed = ${json};`);
  } else {
    for (let name in exposed) {
      const val = exposed[name];
      const json =
        typeof val === "undefined" ? "undefined" : JSON.stringify(val);
      vm.evalCode(`const ${name} = ${json};`);
    }
  }

  // Add partial console:
  const logHandle = vm.newFunction("log", (...args) => {
    const nativeArgs = args.map(vm.dump);
    console.log("console.log from sandbox:", ...nativeArgs);
  });
  const errorHandle = vm.newFunction("error", (...args) => {
    const nativeArgs = args.map(vm.dump);
    console.error("console.error from sandbox:", ...nativeArgs);
  });
  const consoleHandle = vm.newObject();
  vm.setProp(consoleHandle, "log", logHandle);
  vm.setProp(consoleHandle, "error", errorHandle);
  vm.setProp(vm.global, "console", consoleHandle);
  consoleHandle.dispose();
  logHandle.dispose();
  errorHandle.dispose();
  return vm;
}

export async function execInSandbox(code, options = {}) {
  const exposed = options.exposed || {};
  const importMap = options.importMap || {};
  const verbose = options.verbose || false;
  const entrypoint = options.entrypoint || false;
  const header = options.header || "";
  let allowRemoteModuleLoads = true;
  if (typeof options.allowRemoteModuleLoads !== "undefined") {
    allowRemoteModuleLoads = options.allowRemoteModuleLoads;
  }
  let isModule = false;
  let parseable = false;
  try {
    isModule = parseScript(code).isModule;
    parseable = true;
  } catch (e) {
    try {
      // Handle a plain eval with a return value
      code = `(async () => {
        ${code}
      })()`;
      parseScript(code);
      parseable = true;
    } catch (e) {}
  }

  if (!parseable) {
    throw new Error("Unable to parse script");
  }

  if (header) {
    if (verbose) {
      console.log(`Injecting header into script (${header.length} chars)`);
    }
    code = header + "\n" + code;
  }

  importMap["eval-module.js"] = code;
  if (isModule) {
    if (entrypoint) {
      code = `
    import {${entrypoint}} from "eval-module.js";
    globalThis.result = ${entrypoint}(__exposed);
    `;
    } else {
      code = `
      import mod from "eval-module.js";
      globalThis.result = mod(__exposed);
      `;
    }
  }
  const vm = await getNewContextWithGlobals({
    exposed,
    importMap,
    verbose,
    allowRemoteModuleLoads,
    isModule,
  });

  const asyncResult = await vm.evalCodeAsync(code);
  const promise = vm
    .unwrapResult(asyncResult)
    .consume((result) => vm.resolvePromise(result));
  vm.runtime.executePendingJobs();
  const result = await promise;

  // Rethrow errors from the sandbox
  if (result.error) {
    const vmError = vm.dump(result.error);
    result.error.dispose();
    vm.dispose();
    vm.runtime.dispose();
    let error = new Error(vmError.message + "\n" + vmError.stack);
    error.name = vmError.name;
    throw error;
  }

  let value = isModule
    ? vm.getProp(vm.global, "result").consume(vm.dump)
    : vm.dump(result.value);

  result.value.dispose();
  vm.dispose();
  vm.runtime.dispose();
  return value;
}
