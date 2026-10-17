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
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
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
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<string> {
  return (await run(command, args, options)).toString("utf8");
}

/**
 * At most `concurrency` tasks running at once, the rest queued. Used so the
 * indexer keeps every CPU core busy with OCR without starting hundreds of
 * tesseract processes at the same moment.
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}
