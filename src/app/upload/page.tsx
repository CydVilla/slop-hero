import { detectTeslaBrowser } from "@/lib/teslaBrowser.server";

import { UploadClient } from "./UploadClient";

export default async function UploadPage(): Promise<React.JSX.Element> {
  // Tesla's browser can't open local files, but it can embed YouTube — so there
  // we restrict the uploader to the YouTube-link source instead of hiding it.
  const isTesla = await detectTeslaBrowser();
  return <UploadClient youtubeOnly={isTesla} />;
}
