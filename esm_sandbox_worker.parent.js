// Expose the same API to the parent and manage remoting to a worker instance
let workers = [];

function createWorker() {
  let worker = new Worker("esm_sandbox_worker.bundle.js");
  worker.onmessage = function (e) {
    console.log(e.data);
    let resolver = messageResolvers.get(e.data.id);
    if (!resolver) {
      throw new Error("No resolver for message " + JSON.stringify(e.data));
    }
    resolver.dispatchEvent(
      new CustomEvent(e.data.type, { detail: e.data.detail })
    );
  };
  return worker;
}
export function setNumWorkers(numWorkers) {
  if (numWorkers < 1) {
    throw new Error("numWorkers must be >= 1");
  }
  if (numWorkers > workers.length) {
    while (workers.length < numWorkers) {
      workers.push(createWorker());
    }
  } else if (numWorkers < workers.length) {
    // We'd have to make sure to not kill running jobs. Would need to do
    // some testing to see if this multiple worker mechanism is even useful first.
    throw new Error("Can't scale down workers yet")
    // while (workers.length > numWorkers) {
    //   workers.pop().terminate();
    // }
  }
}

let messageID = 1;
let messageResolvers = new Map();

setNumWorkers(1);

class MessageResolver extends EventTarget {
  constructor() {
    super();
    this.messageID = messageID++;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.addEventListener("execInSandboxComplete", (e) => {
      console.log(e);
      this.resolve(e.detail);
      messageResolvers.delete(this.messageID);
    });
    this.addEventListener("execInSandboxError", (e) => {
      this.reject(e.detail);
      messageResolvers.delete(this.messageID);
    });
  }
}


export async function execInSandboxToResolver(code, options = {}) {
  let resolver = new MessageResolver();
  let message = {
    type: "execInSandbox",
    id: resolver.messageID,
    code,
    options,
  };

  let worker = workers[resolver.messageID % workers.length];
  worker.postMessage(message);
  messageResolvers.set(resolver.messageID, resolver);
  return resolver;
}
export async function execInSandbox(code, options = {}) {
  let { promise } = await execInSandboxToResolver(code, options);
  return await promise;
}
