import { spawn } from "node:child_process";

const defaultSignalGroup = (child, signal) => {
  if (!child?.pid) return;
  process.kill(-child.pid, signal);
};

const defaultProbeGroup = (child) => {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
};

export function runAbortableChild(command, args, {
  env = process.env,
  signal = null,
  allowFailure = false,
  timeoutMs = 120_000,
  maxOutput = 1024 * 1024,
  killGraceMs = 1_000,
  terminationWaitMs = 5_000,
  active = null,
  onSpawn = null,
  input = null,
  spawnChild = spawn,
  signalGroup = defaultSignalGroup,
  probeGroup = defaultProbeGroup,
  passFds = [],
} = {}) {
  if (signal?.aborted) return Promise.reject(new Error(`${command} aborted before spawn`));

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let child;
    let timeout = null;
    let escalation = null;
    let terminationPoll = null;
    let terminalError = null;
    let closeResult = null;
    let forceRequested = false;
    const terminationErrors = [];
    const pollMs = Math.max(5, Math.min(25, Math.floor(terminationWaitMs / 100) || 10));

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (terminationPoll) clearTimeout(terminationPoll);
      timeout = null;
      escalation = null;
      terminationPoll = null;
    };
    const finalError = () => terminationErrors.length === 0
      ? terminalError
      : new AggregateError([terminalError, ...terminationErrors].filter(Boolean), terminalError?.message || `${command} termination failed`);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      active?.delete(child);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const rememberTerminationError = (error) => {
      if (error?.code !== "ESRCH") terminationErrors.push(error);
    };
    const send = (killSignal) => {
      try {
        signalGroup(child, killSignal);
      } catch (error) {
        rememberTerminationError(error);
      }
    };
    const probe = () => {
      try {
        return probeGroup(child);
      } catch (error) {
        rememberTerminationError(error);
        return true;
      }
    };
    const scheduleTerminationCheck = () => {
      if (settled || terminationPoll) return;
      terminationPoll = setTimeout(() => {
        terminationPoll = null;
        checkTermination();
      }, pollMs);
    };
    const checkTermination = () => {
      if (settled || !terminalError) return;
      if (!probe()) {
        finish(finalError());
        return;
      }
      if (forceRequested) send("SIGKILL");
      scheduleTerminationCheck();
    };
    const forceKill = () => {
      if (settled) return;
      forceRequested = true;
      if (escalation) clearTimeout(escalation);
      escalation = null;
      send("SIGKILL");
      checkTermination();
    };
    const requestTermination = (error, { graceful = false } = {}) => {
      if (settled) return;
      if (!terminalError) terminalError = error;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (graceful && !forceRequested) {
        send("SIGTERM");
        if (!escalation) escalation = setTimeout(forceKill, killGraceMs);
        checkTermination();
      } else {
        forceKill();
      }
    };
    const abort = () => requestTermination(new Error(`${command} aborted in flight`), { graceful: true });
    const append = (current, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxOutput) throw new Error(`${command} output bound exceeded`);
      return current + bytes.toString("utf8");
    };
    const handleClose = (code, childSignal) => {
      closeResult = { code, signal: childSignal, stdout, stderr };
      if (terminalError) {
        checkTermination();
        return;
      }
      const failure = !allowFailure && code !== 0
        ? new Error(`${command} ${args.join(" ")} failed (${code ?? childSignal}): ${stderr.slice(-2000)}`)
        : null;
      if (probe()) {
        requestTermination(failure || new Error(`${command} process group survived parent close`), { graceful: true });
      } else {
        finish(failure, closeResult);
      }
    };

    // This second check closes the abort-before-spawn race: JavaScript cannot
    // run the abort callback between this check and the synchronous spawn call.
    if (signal?.aborted) { finish(new Error(`${command} aborted before spawn`)); return; }
    try {
      const stdio = [input === null ? "ignore" : "pipe", "pipe", "pipe"];
      for (const fd of passFds) {
        if (!Number.isSafeInteger(fd) || fd < 3) throw new Error(`${command} invalid pass fd`);
        while (stdio.length <= fd) stdio.push("ignore");
        stdio[fd] = fd;
      }
      child = spawnChild(command, args, { env, detached: true, stdio });
    } catch (error) {
      finish(error);
      return;
    }
    active?.add(child);
    if (input !== null) child.stdin.end(input);
    child.stdout?.on("data", (chunk) => {
      if (terminalError) return;
      try { stdout = append(stdout, chunk); } catch (error) { requestTermination(error); }
    });
    child.stderr?.on("data", (chunk) => {
      if (terminalError) return;
      try { stderr = append(stderr, chunk); } catch (error) { requestTermination(error); }
    });
    child.once("error", (error) => requestTermination(error));
    child.once("close", handleClose);
    signal?.addEventListener("abort", abort, { once: true });
    try { onSpawn?.(child); } catch (error) { requestTermination(error); }
    if (signal?.aborted) abort();
    if (!terminalError) timeout = setTimeout(() => requestTermination(new Error(`${command} timed out`), { graceful: true }), timeoutMs);
  });
}
