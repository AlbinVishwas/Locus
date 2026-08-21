import type { Metadata } from "next";
import "./globals.css";
import { ConversationsProvider } from "@/components/ConversationsProvider";

export const metadata: Metadata = {
  title: "Chat",
  description: "A local chat interface for LM Studio",
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
