import { ERRORS, type ErrorCode } from "./catalog";

/** docs/errors.md, generated from the catalog so the page people troubleshoot from can't drift from what the app says. */
export function renderErrorDocs(): string {
  const codes = Object.keys(ERRORS) as ErrorCode[];
  const rows = codes.map((c) => {
    const e = ERRORS[c];
    return `### ${c}: ${e.title}\n\n${e.message}\n\n**What to do:** ${e.action}\n`;
  });
  return [
    "# Error codes",
    "",
    "Every problem Locus reports has a code like `LOCUS-DISK-001`. The same code, title and wording appear on the page or banner,",
    "in the JSON an API answers with (`{ \"code\", \"message\", \"action\" }`, never a stack trace) and here. Full technical details go to the",
    "server's log only, with passwords and keys removed.",
    "",
    "This file is generated from `src/lib/errors/catalog.ts` (`npm run gen:error-docs`); a test fails if they differ.",
    "",
    "| Code | Title |",
    "| --- | --- |",
    ...codes.map((c) => `| [${c}](#${c.toLowerCase()}-${ERRORS[c].title.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().replace(/ +/g, "-")}) | ${ERRORS[c].title} |`),
    "",
    ...rows,
  ].join("\n");
}
