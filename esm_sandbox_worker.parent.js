
export class WorkerPool {
  constructor() {
    this.workers = [];
    this.activeWorkers = new Map(); // worker -> resolver
    this.taskQueue = [];
    this.messageResolvers = new Map();
    this.messageID = 1;
  }

  createWorker() {
    const worker = new Worker("esm_sandbox_worker.bundle.js");
    worker.onmessage = (e) => this.handleWorkerMessage(worker, e);
    return worker;
  }

  handleWorkerMessage(worker, e) {
    console.log(e.data);
    const resolver = this.messageResolvers.get(e.data.id);
    if (!resolver) {
      throw new Error("No resolver for message " + JSON.stringify(e.data));
    }

    resolver.dispatchEvent(
      new CustomEvent(e.data.type, { detail: e.data.detail })
    );

    // Mark worker as available after task completion
    this.activeWorkers.delete(worker);
    this.processNextTask();
  }

  async processNextTask() {
    if (this.taskQueue.length === 0) return;

    const availableWorker = this.getIdleWorker();
    if (!availableWorker) return; // No workers available

    const task = this.taskQueue.shift();
    this.executeTask(availableWorker, task);
  }

  getIdleWorker() {
    // First try to find an inactive worker
    for (const worker of this.workers) {
      if (!this.activeWorkers.has(worker)) {
        return worker;
      }
    }

    // If we haven't reached max workers, create a new one
    if (this.workers.length < this.maxWorkers) {
      const worker = this.createWorker();
      this.workers.push(worker);
      return worker;
    }

    return null; // No idle workers available
  }

  executeTask(worker, task) {
    const { resolver, message } = task;
    this.activeWorkers.set(worker, resolver);
    worker.postMessage(message);
  }

  setNumWorkers(numWorkers) {
    if (numWorkers < 1) {
      throw new Error("numWorkers must be >= 1");
    }

    this.maxWorkers = numWorkers;

    // Scale up immediately if needed
    while (this.workers.length < numWorkers) {
      this.workers.push(this.createWorker());
    }

    // Scale down gracefully
    if (numWorkers < this.workers.length) {
      this.scaleDown(numWorkers);
    }
  }

  async scaleDown(targetNum) {
    // Mark excess workers for removal
    const workersToRemove = this.workers.slice(targetNum);

    // Wait for active tasks to complete on marked workers
    await Promise.all(workersToRemove.map(worker => {
      if (this.activeWorkers.has(worker)) {
        return this.activeWorkers.get(worker).promise;
      }
      return Promise.resolve();
    }));

    // Remove and terminate excess workers
    for (const worker of workersToRemove) {
      const index = this.workers.indexOf(worker);
      if (index !== -1) {
        this.workers.splice(index, 1);
        worker.terminate();
      }
    }
  }
}

export class MessageResolver extends EventTarget {
  constructor() {
    super();
    this.messageID = workerPool.messageID++;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });

    this.addEventListener("execInSandboxComplete", (e) => {
      // console.log(e);
      this.resolve(e.detail);
      workerPool.messageResolvers.delete(this.messageID);
    });

    this.addEventListener("execInSandboxError", (e) => {
      this.reject(e.detail);
      workerPool.messageResolvers.delete(this.messageID);
    });
  }
}

// Create singleton worker pool
export const workerPool = new WorkerPool();

// Export functions with improved worker management
export function setNumWorkers(numWorkers) {
  workerPool.setNumWorkers(numWorkers);
}

export function execInSandboxToResolver(code, options = {}) {
  if (!workerPool.workers.length) {
    console.log("Creating initial worker");
    setNumWorkers(1);
  }

  const resolver = new MessageResolver();
  const message = {
    type: "execInSandbox",
    id: resolver.messageID,
    code,
    options,
  };

  workerPool.messageResolvers.set(resolver.messageID, resolver);

  // Try to get an idle worker
  const idleWorker = workerPool.getIdleWorker();
  if (idleWorker) {
    // Execute immediately if worker is available
    workerPool.executeTask(idleWorker, { resolver, message });
  } else {
    // Queue the task if no workers are available
    workerPool.taskQueue.push({ resolver, message });
  }

  return resolver;
}

export async function execInSandbox(code, options = {}) {
  const { promise } = await execInSandboxToResolver(code, options);
  return await promise;
}
