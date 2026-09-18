import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant text as markdown.
 *
 * Before this, content went into a <p> with `whitespace-pre-wrap`, so a model
 * writing **bold** produced literal asterisks on screen — and the markdown
 * tables our own page extractor generates rendered as rows of pipes.
 *
 * Styling is per-element rather than via a typography plugin, so every colour
 * traces back to the palette in globals.css and the body text keeps matching
 * the 15px/1.7 rhythm the rest of the transcript uses.
 */

const P = "text-[15px] leading-[1.7] text-primary";

export default function Markdown({ children }: { children: string }) {
  return (
    // `space-y-3` rather than margins on every child: it collapses correctly
    // when a block is the first or last thing in a streaming message.
    <div className="space-y-3 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className={P}>{children}</p>,

          strong: ({ children }) => (
            <strong className="font-semibold text-primary">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,

          // Headings stay close to body size. A model asked for structure
          // reaches for ## constantly, and browser defaults would turn a
          // short answer into a poster.
          h1: ({ children }) => (
            <h1 className="mt-1 text-[17px] font-semibold text-primary">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-1 text-[16px] font-semibold text-primary">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-1 text-[15px] font-semibold text-primary">{children}</h3>
          ),

          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 marker:text-secondary">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 marker:text-secondary">{children}</ol>
          ),
          li: ({ children }) => <li className={P}>{children}</li>,

          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 decoration-secondary hover:decoration-primary"
            >
              {children}
            </a>
          ),

          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3 text-secondary">
              {children}
            </blockquote>
          ),

          code: ({ className, children }) => {
            // react-markdown gives fenced blocks a language class and inline
            // code none; only the block form should get its own surface.
            const isBlock = Boolean(className);
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded-lg bg-surface p-3 font-mono text-[13px] leading-[1.6] text-primary">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[13px] text-primary">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,

          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[14px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line px-3 py-2 text-left font-semibold text-primary">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line px-3 py-2 align-top text-primary">
              {children}
            </td>
          ),

          hr: () => <hr className="border-line" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
