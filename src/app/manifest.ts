import type { MetadataRoute } from "next";

/** Lets Locus be installed as a web app (Chrome, Edge, Safari "Add to Dock"): its own window, name and icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Locus",
    short_name: "Locus",
    description: "Search inside your company's PDFs: file, page number and snippet, in milliseconds.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0c",
    theme_color: "#0a0a0c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
