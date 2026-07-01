import type { Metadata } from "next";

import { DashboardClient } from "./DashboardClient";

export const metadata: Metadata = {
  title: "Metrics · Slop Hero",
  description:
    "Anonymous gameplay metrics and the autonomous tuning recommendations derived from them.",
};

export default function DashboardPage(): React.JSX.Element {
  return <DashboardClient />;
}
