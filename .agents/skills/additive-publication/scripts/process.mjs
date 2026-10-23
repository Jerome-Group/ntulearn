import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

export function run(command, args, cwd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stopped = null;
    let settlement;
    const stop = (reason) => {
      stopped ??= reason;
      child.kill("SIGKILL");
      settlement ??= setTimeout(() => {
        reject(new Error(`Child ${child.pid} did not settle. Keep its fixture at ${cwd}.`));
      }, 5000);
    };
    const deadline = setTimeout(() => stop("timeout"), timeout);
    const collect = (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) stop("output limit");
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(settlement);
      resolve({ command, args, code, signal, stopped, settled: true, stdout, stderr });
    });
  });
}
