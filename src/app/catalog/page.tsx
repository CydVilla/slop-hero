import { detectTeslaBrowser } from "@/lib/teslaBrowser.server";

import { CatalogClient } from "./CatalogClient";

export default async function CatalogPage(): Promise<React.JSX.Element> {
  const isTesla = await detectTeslaBrowser();
  return <CatalogClient isTesla={isTesla} />;
}
