"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for errors thrown in the ROOT layout (Phase 8).
 *
 * It replaces the root layout, so it gets no globals.css, no fonts and no theme
 * class — everything it needs is inline here. That is also why the palette is
 * hard-coded twice (light/dark via `prefers-color-scheme`) instead of using the
 * app's CSS variables: those variables live in a stylesheet this render never
 * loads. `metadata` is not allowed in a client boundary, hence `<title>`.
 *
 * Nothing here reads the thrown value's message in production (Next sends a
 * generic one for server errors); the digest is the link to the server log.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest)
      : null;

  return (
    <html lang="en">
      <head>
        <title>Something went wrong — claude-web</title>
        <meta name="robots" content="noindex" />
        <style>{`
          :root { color-scheme: light dark; }
          body {
            margin: 0;
            min-height: 100dvh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
            background: #faf9f5;
            color: #1f1e1d;
            font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            line-height: 1.5;
          }
          @media (prefers-color-scheme: dark) {
            body { background: #262624; color: #f5f4ef; }
            .muted { color: #a3a29c !important; }
            .card { border-color: #3e3d38 !important; }
            .primary { background: #d97757 !important; color: #1f1e1d !important; }
            .secondary { border-color: #4a4944 !important; color: #f5f4ef !important; }
          }
          .card { max-width: 28rem; width: 100%; display: flex; flex-direction: column; gap: 1rem; }
          h1 { font-size: 1.5rem; line-height: 1.2; margin: 0; font-weight: 500; }
          p { margin: 0; font-size: 0.875rem; }
          .muted { color: #6b6a66; }
          .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
          .row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
          button, a {
            display: inline-flex; align-items: center; justify-content: center;
            height: 2.25rem; padding: 0 1rem; border-radius: 0.5rem;
            font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer;
            font-family: inherit;
          }
          .primary { background: #d97757; color: #ffffff; border: 1px solid transparent; }
          .secondary { background: transparent; color: #1f1e1d; border: 1px solid #dad7cb; }
        `}</style>
      </head>
      <body>
        <div className="card">
          <h1>Something went wrong</h1>
          <p className="muted">
            The app failed before it could finish starting up. Reloading usually
            clears it; if it keeps happening, check the server log.
          </p>
          {digest ? <p className="mono muted">digest {digest}</p> : null}
          <div className="row">
            <button type="button" className="primary" onClick={() => retry()}>
              Try again
            </button>
            {/*
              A document reload, not a client-side navigation: this boundary
              replaces the root layout, so the thing that failed is the frame
              every route renders into. `retry()` re-runs the segment; only a
              full reload rebuilds the frame from scratch.
            */}
            <button type="button" className="secondary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
