import type { Metadata } from "next";
import "./globals.css";
import { ConversationsProvider } from "@/components/ConversationsProvider";

export const metadata: Metadata = {
  title: "Assay",
  description: "A local chat and document-search interface for LM Studio",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">
        <ConversationsProvider>{children}</ConversationsProvider>
      </body>
    </html>
  );
}
