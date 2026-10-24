import type { MetadataRoute } from "next";

/**
 * Web app manifest: lets players install Slop Hero to the home screen and play
 * without browser chrome. iPhone Safari has no Fullscreen API, so on a short
 * landscape screen (the iPhone Duo open is ~626 px tall) installing is the
 * only way to win back the ~60 px Safari's toolbars take from the highway.
 * iOS treats `fullscreen` as `standalone`; Android honours it fully.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Slop Hero",
    short_name: "Slop Hero",
    description:
      "A touchscreen rhythm game: upload a song, get a generated chart, and tap along.",
    start_url: "/",
    scope: "/",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
    orientation: "any",
    background_color: "#05060a",
    theme_color: "#05060a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
