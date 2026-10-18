import type { Metadata } from "next";
import SearchView from "@/components/search/SearchView";

export const metadata: Metadata = {
  title: "Search · Locus",
  description: "Full-text search over the indexed tender PDFs",
};

export default function SearchPage() {
  return <SearchView />;
}
