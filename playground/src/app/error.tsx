"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="border" role="alert">
      <div className="border-b px-5 py-4">
        <h1 className="text-lg">This page could not render</h1>
        <p className="mt-1 max-w-[70ch] text-muted-foreground">
          The request failed before the page finished. If the instance is running, reload. If it is not, start it and
          check the key on the Setup page.
        </p>
      </div>
      <div className="space-y-3 p-5">
        <p className="font-data text-xs break-all text-signal">{error.message}</p>
        {error.digest ? <p className="font-data text-xs text-muted-foreground">Digest {error.digest}</p> : null}
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </section>
  );
}
