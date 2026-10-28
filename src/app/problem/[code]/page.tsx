import { notFound } from "next/navigation";
import ErrorPage from "@/components/ErrorPage";
import { isErrorCode } from "@/lib/errors/catalog";

/**
 * /problem/<code>: the catalog entry as a page. The app links here (and redirects here) for the situations that
 * deserve a page of their own: not signed in, no access, server unreachable, storage full, index still building,
 * maintenance. Nothing in it depends on the database, so it renders even when the index or the server is down.
 */
export default async function ProblemPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const upper = code.toUpperCase();
  if (!isErrorCode(upper)) notFound();
  return <ErrorPage code={upper} />;
}
