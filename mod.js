import quickjs from "./build/quickjs-module.js";
import { parse as acornParse } from "npm:acorn@8.7.1";
export { quickjs };

const MEMORY_LIMIT = 1024 * 1024 * 32;
const INTERRUPT_AFTER_DEADLINE = 0; // ms. 0 for none
const MAX_INTERRUPTS = 1024;
const IS_WORKER =
  typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

// TODO: MAX_IMPORTS (depth or just total num)

function parseScript(script) {
  // We expect to fail if there's an import/export:
  try {
    let parsed = acornParse(script, {
      ecmaVersion: 2022,
      sourceType: "script",
    });
    return {
      isModule: false,
      parsed,
    };
  } catch (e) {}
  try {
    let parsed = acornParse(script, {
      ecmaVersion: 2022,
      sourceType: "module",
    });
    return {
      isModule: true,
      parsed,
    };
  } catch (e) {}

  throw new Error("Unable to parse script");
}

function getURL(string, base) {
  let url;

  try {
    url = new URL(string, base);
  } catch (_) {}

  return url;
}

async function getNewContextWithGlobals({
  exposed,
  maxInterrupts = MAX_INTERRUPTS,
  interruptAfterDeadline = INTERRUPT_AFTER_DEADLINE,
  importMap,
  verbose,
  allowRemoteModuleLoads,
  allowFileModuleLoads,
  prepareVM,
  isModule,
}) {
  console.log("Getting new context", maxInterrupts);
  function getValidImportURL(string, base) {
    let url = getURL(string, base);
    if (!url) {
      return false;
    }

    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      (allowFileModuleLoads && url.protocol == "file:")
    ) {
      return url;
    }
    return false;
  }
  const qjs = await quickjs.newQuickJSAsyncWASMModule();
  const runtime = qjs.newRuntime();

  runtime.setMemoryLimit(MEMORY_LIMIT);
  // Need to build to a newer version for this
  // runtime.setMaxStackSize(1024 * 320)
  let interruptCycles = 0;
  let deadline;
  if (interruptAfterDeadline > 0) {
    deadline = Date.now() + interruptAfterDeadline;
  }
  runtime.setInterruptHandler(() => {
    return (
      ++interruptCycles > maxInterrupts || (deadline && Date.now() > deadline)
    );
  });

  // Alternatively we could compile the bundle into an eval instead of allowing
  // the runtime to load modules. This might make sense if it's not possible
  // to handle errors properly from module evaluation.
  runtime.setModuleLoader(
    async (moduleName) => {
      if (verbose) {
        console.log(
          `Loading module by name ${moduleName}. Is HTTP url? ${getValidImportURL(
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

      const url = getValidImportURL(moduleName);
      if (!url) {
        throw new Error("Can't find module " + moduleName);
      }
      if (url.protocol == "file:") {
        let text = await Deno.readTextFile(url.pathname);
        return text;
      }
      if (url) {
        let url = new URL(moduleName);
        let resp = await fetch(url);
        let text = await resp.text();
        return text;
      }
    },
    (baseModuleName, moduleNameRequest) => {
      if (verbose) {
        console.log(
          `Module resolver: ${baseModuleName} - ${moduleNameRequest}`
        );
      }
      if (getValidImportURL(moduleNameRequest, baseModuleName)) {
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

  // Enough to get DOMParser working, with some logging for scripts that try to access window
  vm.evalCode(`
    const window = new Proxy({
      performance: {
        now: () => Date.now(),
      },
      PerformanceObserver: class {},
      PerformanceEntry: class {},
      PerformanceObserverEntryList: class {},
    }, {
      get(target, prop, receiver) {
        console.log("Script attempting window lookup", prop)
        return Reflect.get(...arguments);
      },
    });
  `);

  prepareVM(vm);
  
  // This doesn't work yet:
  // const setTimeoutHandle = vm.newFunction(
  //   "setTimeout",
  //   (vmFnHandle, timeoutHandle) => {
  //     const vmFnHandleCopy = vmFnHandle.dup();
  //     const timeout = vm.dump(timeoutHandle);
  //     const timeoutID = setTimeout(() => {
  //       console.log("Calling vm function")
  //       vm.callFunction(vmFnHandleCopy, vm.undefined);
  //     }, timeout);

  //     return vm.newNumber(timeoutID);
  //   }
  // );
  // vm.setProp(vm.global, "setTimeout", setTimeoutHandle);
  // setTimeoutHandle.dispose();

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
  const prepareVM = options.prepareVM || function() {};
  let allowFileModuleLoads = options.allowFileModuleLoads || false;
  let allowRemoteModuleLoads = true;
  if (typeof options.allowRemoteModuleLoads !== "undefined") {
    allowRemoteModuleLoads = options.allowRemoteModuleLoads;
  }

  if (verbose) {
    console.log("Exec in sandbox", {
      exposed,
      importMap,
      verbose,
      entrypoint,
      header,
      allowFileModuleLoads,
      prepareVM,
      allowRemoteModuleLoads,
      code,
    });
  }

  let isModule = false;
  let parseable = false;
  try {
    isModule = parseScript(code).isModule;
    parseable = true;
  } catch (e) {
    try {
      // Handle a plain eval with a return value
      // Could handle a single expression like `await 2` if we walked the AST, but for
      // now you'd need `return await 2` or `(async () => await 2)()`
      code = `(async () => {
        ${code}
      })()`;
      parseScript(code);
      parseable = true;
    } catch (e) {
    }
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
      (async() => {
        try {
          globalThis.__result = await ${entrypoint}(__exposed);
        } catch(error) {
          globalThis.__error = error;
        }
      })();
    `;
    } else {
      code = `
      import mod from "eval-module.js";
      (async() => {
        try {
          globalThis.__result = await mod(__exposed);
        } catch(error) {
          globalThis.__error = error;
        }
      })();
      `;
    }
  }
  const vm = await getNewContextWithGlobals({
    exposed,
    importMap,
    verbose,
    allowRemoteModuleLoads,
    allowFileModuleLoads,
    prepareVM,
    isModule,
    maxInterrupts: options.maxInterrupts,
    interruptAfterDeadline: options.interruptAfterDeadline,
  });

  // Error case 1: awaiting this promise will throw if
  // there's an error in the main event loop
  const asyncResult = await vm.evalCodeAsync(code);

  const promise = vm
    .unwrapResult(asyncResult)
    .consume((result) => vm.resolvePromise(result));
  vm.runtime.executePendingJobs();

  const result = await promise;

  // Error case 2: the result will have an error object if there was an exception in
  // an async event. But NOT if being evaluated as a module.
  if (result.error) {
    const vmError = vm.dump(result.error);
    result.error.dispose();
    vm.dispose();
    vm.runtime.dispose();
    let error = new Error(vmError.message + "\n" + vmError.stack);
    error.name = vmError.name;
    console.error("Error in vm:", vmError);
    throw error;
  }

  // Error case 3: we catch an async error in a module and stick it on globalThis.
  let errorValue = isModule
    ? vm.getProp(vm.global, "__error").consume(vm.dump)
    : null;
  if (errorValue) {
    vm.dispose();
    vm.runtime.dispose();
    let error = new Error(errorValue.message + "\n" + errorValue.stack);
    error.name = errorValue.name;
    console.error("Error in vm (module):", errorValue);
    throw error;
  }

  let value = isModule
    ? vm.getProp(vm.global, "__result").consume(vm.dump)
    : vm.dump(result.value);

  result.value.dispose();
  vm.dispose();
  vm.runtime.dispose();
  return value;
}

if (IS_WORKER) {
  self.onmessage = async function (e) {
    if (!e.data) {
      return;
    }
    let { code, options, id } = e.data;
    let start = performance.now();
    if (e.data.type == "execInSandbox") {
      try {
        if (!code) {
          throw new Error("No `code` provided");
        }
        if (!id) {
          console.error(e.data);
          throw new Error("No `id` provided, can't postMessage back");
        }

        let execResult = execInSandbox(code, options);
        self.postMessage({
          type: "execInSandboxStarted",
          id,
          detail: {
            now: start,
          },
        });
        let resolvedResult = await execResult;
        self.postMessage({
          type: "execInSandboxComplete",
          id,
          detail: {
            now: performance.now(),
            runtime: performance.now() - start,
            result: resolvedResult,
          },
        });
      } catch (e) {
        console.error("execInSandboxError", e);
        self.postMessage({
          type: "execInSandboxError",
          id,
          detail: {
            now: performance.now(),
            runtime: performance.now() - start,
            error: e.toString(),
          },
        });
      }
    }
  };
}
