/** npm run gen:error-docs: writes docs/errors.md from the error catalog. */
import fs from "node:fs";
import path from "node:path";
import { renderErrorDocs } from "../src/lib/errors/docs";

fs.writeFileSync(path.join(process.cwd(), "docs", "errors.md"), renderErrorDocs());
console.log("wrote docs/errors.md");
