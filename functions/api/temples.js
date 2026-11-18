/**
 * Cloudflare Pages Function — GET /api/temples?lat=..&lng=..&radius=..
 *
 * Pages serves every static file from public/ on its own. Only /api/temples
 * reaches this function, which reuses the exact same Overpass proxy and edge
 * cache as the standalone Worker (src/worker.js). There is no duplicate logic.
 *
 * This lets the same repository deploy either as:
 *   - a Worker with static assets (wrangler deploy), or
 *   - a Pages project named "mandir-marg" (https://mandir-marg.pages.dev).
 */

import { handleTemplesRoute } from "../../src/worker.js";

export async function onRequest(context) {
  const response = await handleTemplesRoute(context.request, context);
  if (response) return response;

  return new Response(JSON.stringify({ error: "Not found." }), {
    status: 404,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
