import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/root.ts";
import stylesheet from "./app.css?url";

export const links: Route.LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];

export const Layout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <Meta />
      <Links />
    </head>
    <body className="bg-white font-sans text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {children}
      <ScrollRestoration />
      <Scripts />
    </body>
  </html>
);

export default function App() {
  return <Outlet />;
}

export const ErrorBoundary = ({ error }: Route.ErrorBoundaryProps) => (
  <main className="mx-auto max-w-2xl p-8">
    <h1 className="text-2xl font-semibold">Something went wrong</h1>
    <p className="mt-2 text-neutral-500">
      {isRouteErrorResponse(error) ? `${error.status} ${error.data ?? error.statusText}` : String(error)}
    </p>
    <a className="mt-4 inline-block text-blue-600 underline" href="/">
      Open another repository
    </a>
  </main>
);
