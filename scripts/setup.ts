/**
 * npm run setup: an interactive set-up for a new computer. It creates .env.local from .env.example (or updates
 * the one you have, keeping every setting it doesn't ask about), generates SESSION_SECRET, asks for the admin
 * password (stored only as a hash, never printed back), asks which kind of storage server to connect and tests
 * it, and picks where the index is kept. Works on macOS, Windows and Linux. Answers can also be piped in, one
 * per line, in the order asked (that is how the automated checks run it).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadEnvConfig } from "@next/env";
import { hashPasscode } from "../src/lib/records/passcodes";
import { defaultDataDir } from "../src/lib/library/config";
import { loadServerConfig, ServerConfigError, describeServer, isAbsolutePath } from "../src/lib/server/config";
import { createConnector } from "../src/lib/server/connector";
import { diskInfo, mbOrGb } from "../src/lib/server/disk";
import { dropPlaceholders, removeEnvKey, setEnvValue } from "./lib/envFile";

class Prompter {
  private rl: readline.Interface;
  private lines: AsyncIterator<string> | null = null;
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    if (!process.stdin.isTTY) this.lines = this.rl[Symbol.asyncIterator]();
  }
  async ask(question: string, def = "", secret = false): Promise<string> {
    const suffix = def ? ` [${def}]` : "";
    process.stdout.write(`${question}${suffix}: `);
    let answer: string;
    if (this.lines) {
      const next = await this.lines.next();
      answer = next.done ? "" : next.value;
      process.stdout.write(secret ? "\n" : `${answer}\n`);
    } else if (secret) {
      answer = await this.askHidden();
    } else {
      answer = await new Promise<string>((resolve) => this.rl.once("line", resolve));
    }
    return answer.trim() === "" ? def : answer.trim();
  }
  /** Reads a line without echoing it. */
  private askHidden(): Promise<string> {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let buf = "";
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            stdin.setRawMode(false);
            stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve(buf);
          }
          if (ch === "\u0003") process.exit(130);
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      stdin.setRawMode(true);
      stdin.on("data", onData);
    });
  }
  async yes(question: string, def = true): Promise<boolean> {
    const a = (await this.ask(`${question} (y/n)`, def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
  }
  close() {
    this.rl.close();
  }
}

async function main() {
  const root = process.cwd();
  const envFile = path.join(root, ".env.local");
  const example = path.join(root, ".env.example");
  const p = new Prompter();
  console.log("\nLocus setup. Press Enter to accept the value in [brackets].\n");

  let text: string;
  if (fs.existsSync(envFile)) {
    if (!(await p.yes(".env.local already exists. Update it (settings not asked about here are kept)?"))) {
      console.log("Nothing changed.");
      p.close();
      return;
    }
    text = fs.readFileSync(envFile, "utf8");
  } else {
    text = fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "";
  }
  text = dropPlaceholders(text); // a "<like-this>" value is a blank to fill in, not a setting
  const set = (k: string, v: string) => (text = setEnvValue(text, k, v));

  // Sign-in
  if (!/^SESSION_SECRET=.+/m.test(text)) set("SESSION_SECRET", randomBytes(32).toString("hex"));
  set("LOCUS_USERS_ENABLED", "true");
  set("LOCUS_LIBRARY_ENABLED", "true");
  if (!/^LOCUS_SIGNUP=/m.test(text) || /^LOCUS_SIGNUP=code/m.test(text)) set("LOCUS_SIGNUP", "off");
  let password = await p.ask("Admin password (at least 8 characters; stored only as a hash)", "", true);
  while (password.length < 8) {
    console.log("  Too short: use at least 8 characters.");
    password = await p.ask("Admin password", "", true);
  }
  const again = await p.ask("Type it again", "", true);
  if (again !== password) {
    console.error("The two passwords differ. Nothing was written. Run npm run setup again.");
    p.close();
    process.exit(1);
  }
  set("LOCUS_ADMIN_PASSCODE_HASH", await hashPasscode(password));
  text = removeEnvKey(text, "LOCUS_ADMIN_PASSCODE"); // a plain password would win over the hash
  password = "";

  // Storage server
  console.log("\nStorage server: where the PDFs live. 'folder' is a folder on this computer or a network share your system has mounted; 's3' is MinIO, AWS S3 or any S3-compatible server; 'none' skips it for now.");
  let type = (await p.ask("Server type (folder / s3 / none)", "none")).toLowerCase();
  while (!["folder", "s3", "none"].includes(type)) type = (await p.ask("Please type folder, s3 or none", "none")).toLowerCase();
  set("LOCUS_SERVER_TYPE", type);
  if (type === "folder") {
    let dir = await p.ask("Folder (a path like /Volumes/tenders, \\\\server\\share\\tenders or Z:\\tenders)");
    while (!isAbsolutePath(dir)) dir = await p.ask("That isn't a full path. Folder");
    if (!fs.existsSync(dir) && !(await p.yes(`${dir} isn't reachable from here right now. Use it anyway?`, false))) {
      console.error("Run npm run setup again once the folder is reachable.");
      p.close();
      process.exit(1);
    }
    set("LOCUS_SERVER_PATH", dir);
  } else if (type === "s3") {
    set("LOCUS_SERVER_S3_ENDPOINT", await p.ask("Endpoint URL (leave empty for AWS S3), e.g. http://minio.local:9000", ""));
    set("LOCUS_SERVER_S3_REGION", await p.ask("Region", "us-east-1"));
    set("LOCUS_SERVER_S3_BUCKET", await p.ask("Bucket"));
    set("LOCUS_SERVER_S3_PREFIX", await p.ask("Folder inside the bucket (prefix; empty for the whole bucket)", ""));
    set("LOCUS_SERVER_S3_ACCESS_KEY", await p.ask("Access key"));
    set("LOCUS_SERVER_S3_SECRET_KEY", await p.ask("Secret key (hidden)", "", true));
    set("LOCUS_SERVER_S3_FORCE_PATH_STYLE", (await p.yes("Use path-style addressing? (yes for MinIO and most self-hosted servers)", true)) ? "true" : "false");
  }
  set("LOCUS_SYNC_INTERVAL_MIN", await p.ask("Check the server for changes every how many minutes", "10"));

  // Where the index lives
  const defDir = process.env.LOCUS_DATA_DIR ?? defaultDataDir();
  console.log(`\nThe index is kept in a folder on this computer. ${mbOrGb(diskInfo(defDir).freeBytes)} is free on the disk that holds the default (${defDir}).`);
  const dataDir = path.resolve(await p.ask("Index folder", defDir));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
  if (dataDir !== defaultDataDir()) set("LOCUS_DATA_DIR", dataDir);
  set("LOCUS_MIN_FREE_GB", "5");
  set("LOCUS_USER_UPLOAD_MB", "20000");
  set("LOCUS_CHAT_ENABLED", "false");

  fs.writeFileSync(envFile, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
  console.log(`\nSaved ${envFile} (settings only you should see: don't share or commit it).`);

  // Try the server straight away, from the file just written.
  if (type !== "none") {
    // Read the file back the way the app will, so a quoting mistake shows up here.
    loadEnvConfig(root, false, { info: () => {}, error: () => {} }, true);
    try {
      const cfg = loadServerConfig();
      const connector = createConnector(cfg);
      console.log(`\nTesting the connection to ${describeServer(cfg)}…`);
      const result = await connector.test(AbortSignal.timeout(20_000));
      await connector.close();
      console.log(result.ok ? `  ✓ ${result.message}` : `  ✗ ${result.message}${result.code ? ` (${result.code})` : ""}\n  The settings are saved; fix the server or the settings and press Test connection on the Server page.`);
    } catch (err) {
      console.log(`  ✗ ${err instanceof ServerConfigError ? err.message : err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nNext:\n  npm run doctor   check this computer has everything\n  npm run build    build the app (once, and after updates)\n  npm start        run Locus, then open http://localhost:3000 and sign in as admin\n");
  p.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
