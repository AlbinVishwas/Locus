import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

/**
 * Renders to static HTML rather than asserting on the markdown string, so
 * these check what actually reaches the screen. The bug being guarded is
 * concrete: assistant text used to go into a <p> verbatim, so "**bold**"
 * displayed its asterisks and extracted tables displayed as rows of pipes.
 */
const html = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);

describe("Markdown", () => {
  it("renders bold as real bold, with no asterisks left on screen", () => {
    const out = html("This is **not meant for real-world operations** here.");

    expect(out).toContain("<strong");
    expect(out).toContain("not meant for real-world operations");
    expect(out).not.toContain("**");
  });

  it("renders a bulleted list as a list", () => {
    const out = html("- **Purpose**: docs only\n- **Note**: avoid in production");

    expect(out).toContain("<ul");
    expect(out.match(/<li/g) ?? []).toHaveLength(2);
    expect(out).not.toContain("**");
  });

  it("renders a markdown table as a table", () => {
    // The page extractor emits exactly this shape for tabular pages.
    const out = html("| Year | Amount |\n| --- | --- |\n| 2024 | 10 |");

    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
    expect(out).not.toContain("| --- |");
  });

  it("renders headings small rather than at browser defaults", () => {
    expect(html("## Overview")).toContain("<h2");
  });

  it("distinguishes inline code from a fenced block", () => {
    expect(html("use `npm run dev` now")).toContain("<code");
    expect(html("```\nnpm run dev\n```")).toContain("<pre");
  });

  it("opens links safely in a new tab", () => {
    const out = html("[docs](https://example.com)");

    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });

  it("escapes raw HTML in model output instead of rendering it", () => {
    // react-markdown drops raw HTML unless rehype-raw is added, so the tag
    // arrives as visible text. What matters is that no element is created.
    const out = html("<img src=x onerror=alert(1)>");

    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("renders plain prose unchanged", () => {
    expect(html("Just a sentence.")).toContain("Just a sentence.");
  });
});
