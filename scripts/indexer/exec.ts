import { execFile } from "node:child_process";

/**
 * Runs an external program (pdftotext, tesseract, ...) and resolves with its
 * output. Arguments are passed as an array, never through a shell, so a
 * filename with spaces or quotes is just a filename.
 *
 * Every call has a timeout. A malformed page can send poppler or tesseract
 * into a very long loop; when the timeout fires the process is killed and the
 * caller records that page as failed instead of the whole run hanging.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean
  ) {
    super(message);
  }
}

export function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; niceness?: number }
): Promise<Buffer> {
  // A positive niceness starts the tool at a lower priority (via nice(1)), so a run of OCR
  // on every core still leaves the laptop's other programs, and this server, responsive.
  const lowered = options.niceness !== undefined && options.niceness > 0;
  return new Promise((resolve, reject) => {
    execFile(
      lowered ? "nice" : command,
      lowered ? ["-n", String(Math.min(19, Math.round(options.niceness as number))), command, ...args] : args,
      {
        encoding: "buffer",
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 512 * 1024 * 1024,
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const timedOut = error.killed === true || error.signal === "SIGKILL";
        const detail = stderr.toString("utf8").trim().split("\n").slice(-2).join(" ");
        reject(
          new ToolError(
            timedOut
              ? `${command} timed out after ${options.timeoutMs} ms`
              : `${command} failed: ${detail || error.message}`,
            timedOut
          )
        );
      }
    );
  });
}

export async function runText(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; niceness?: number }
): Promise<string> {
  return (await run(command, args, options)).toString("utf8");
}

/**
 * At most `concurrency` tasks running at once, the rest queued. Used so the
 * indexer keeps every CPU core busy with OCR without starting hundreds of
 * tesseract processes at the same moment.
 *
 * A task can carry a priority (default 0): when a slot frees up, the highest
 * priority waiting task starts first, first come first served among equals.
 * Uploads use it so reading the text of the next file isn't queued behind
 * every OCR page of the files before it.
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  let order = 0;
  const queue: Array<{ priority: number; order: number; start: () => void }> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i;
    }
    const [job] = queue.splice(best, 1);
    active++;
    job.start();
  };

  return function limit<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        priority,
        order: order++,
        start: () => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        },
      });
      next();
    });
  };
}
