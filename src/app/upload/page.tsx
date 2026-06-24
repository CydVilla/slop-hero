import Link from "next/link";

import { detectTeslaBrowser } from "@/lib/teslaBrowser.server";

import { UploadClient } from "./UploadClient";
import styles from "./upload.module.css";

export default async function UploadPage(): Promise<React.JSX.Element> {
  const isTesla = await detectTeslaBrowser();

  if (isTesla) {
    return (
      <main className={styles.main}>
        <header className={styles.header}>
          <Link href="/" className={styles.back}>
            ‹ Home
          </Link>
        </header>

        <section className={styles.body}>
          <div className={styles.intro}>
            <h1 className={styles.title}>Uploading isn&apos;t available here</h1>
            <p className={styles.subtitle}>
              The Tesla browser can&apos;t open local files, so uploads are
              disabled. Pick from the built-in tracks instead — or upload from a
              phone or computer, then add it via a PR.
            </p>
          </div>

          <p className={styles.demoLink}>
            Browse the <Link href="/catalog">track catalog →</Link>
          </p>
        </section>
      </main>
    );
  }

  return <UploadClient />;
}
