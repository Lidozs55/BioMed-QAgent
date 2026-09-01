import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
  streaming?: boolean;
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-4 decoration-current/60 hover:decoration-current"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const inline = className === undefined;
    return (
      <code
        className={cn(
          "font-mono text-xs",
          inline
            ? "rounded bg-primary-foreground/15 px-1 py-0.5"
            : "block overflow-x-auto",
        )}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-md bg-primary-foreground/15 p-2">
      {children}
    </pre>
  ),
  p: ({ children }) => (
    <p className="mb-1 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-1 list-disc pl-4">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal pl-4">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="my-0.5">{children}</li>
  ),
  h1: ({ children }) => (
    <h1 className="mb-1 text-lg font-semibold">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1 text-base font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 text-sm font-semibold">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 text-sm font-semibold">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 text-sm font-semibold">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 text-sm font-semibold">{children}</h6>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-current/30 pl-2 italic">
      {children}
    </blockquote>
  ),
  hr: () => <Separator className="my-2 bg-current/20" />,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through">{children}</del>,
  table: ({ children }) => (
    <Table className="my-1 border-collapse text-left text-xs">{children}</Table>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => (
    <TableHead className="h-auto py-1 pr-2 pl-0 text-xs font-semibold">
      {children}
    </TableHead>
  ),
  td: ({ children }) => (
    <TableCell className="border-b border-current/10 py-1 pr-2 pl-0 text-xs whitespace-normal">
      {children}
    </TableCell>
  ),
};

export function MarkdownContent({
  content,
  className,
  streaming = false,
}: MarkdownContentProps) {
  return (
    <div
      className={cn("markdown-content", className)}
      data-streaming={streaming}
      aria-busy={streaming}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
