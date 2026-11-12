/**
 * Next 16 `proxy` (the middleware successor): the session gate in front of
 * the product, and the permanent redirect for pre-0100 workspace URLs.
 *
 * Only `/w/:path*` is matched. Everything else either is public (`/login`,
 * `/start`, `/docs`), decides for itself with `getSession()` (the hub, the
 * admin pages), or is an API path that Next rewrites to the API before this
 * runs and that the API authenticates on its own. Without a session the
 * person is sent to `/login?next=<path>`; the page they wanted is not
 * rendered at all, so nothing behind `/w` ever streams to a stranger.
 *
 * The Supabase client is built on the request's cookies and writes back to
 * the *response*: `auth.getUser()` may refresh an expiring token, and this is
 * the one place in a request where the refreshed cookie can be set before
 * any Server Component reads it. Skips the gate when Supabase Auth is not
 * configured (demo deployments have no sessions to gate on).
 *
 * Legacy URLs: workspaces used to live at `/w/<org>/<workspace>/…`. After the
 * session check, a path of that shape (`@/lib/legacy-workspace-path`) gets a
 * 308 to `/w/<slug>/…`, query string kept. The slug comes from the API
 * (`GET /api/workspaces/<a>~<b>`, the person's cookie forwarded), because the
 * pair's second half is not always today's slug; when the API will not say —
 * not a member, unknown pair, API unreachable — the second half is the best
 * guess, and the workspace layout 404s it if it is wrong. Must not break: the
 * redirect carries any refreshed session cookie, and it never fires for a
 * current `/w/<slug>/…` URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { authCookieName, publicEnv, serverSupabaseUrl, supabaseAuthConfigured } from "@/lib/public-env";
import { currentWorkspacePath, legacyWorkspacePath } from "@/lib/legacy-workspace-path";
import type { WorkspaceResponse } from "@bcontext-dev/contract/workspaces";

function supabaseConfigured(): boolean {
  return supabaseAuthConfigured();
}

/** How long the legacy lookup may take before the redirect falls back to its guess. */
const LEGACY_LOOKUP_TIMEOUT_MS = 3000;

/** Session gate + legacy redirect for `/w/*`. The `server-timing` header exposes its cost in devtools. */
export async function proxy(req: NextRequest) {
  const started = performance.now();
  const timing = () => `proxy-auth;dur=${(performance.now() - started).toFixed(1)}`;
  let res = NextResponse.next({ request: req });

  if (supabaseConfigured()) {
    const supabase = createServerClient(
      serverSupabaseUrl(),
      publicEnv().supabaseAnonKey,
      {
        cookieOptions: { name: authCookieName() },
        cookies: {
          get(name: string) {
            return req.cookies.get(name)?.value;
          },
          set(name: string, value: string, options: CookieOptions) {
            res.cookies.set({ name, value, ...options });
          },
          remove(name: string, options: CookieOptions) {
            res.cookies.set({ name, value: "", ...options });
          },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", req.nextUrl.pathname);
      const redirect = NextResponse.redirect(url);
      redirect.headers.set("server-timing", timing());
      return redirect;
    }
  }

  const legacy = legacyWorkspacePath(req.nextUrl.pathname);
  if (legacy) {
    const slug = (await currentSlugFor(req, legacy.ref)) ?? legacy.fallbackSlug;
    const url = req.nextUrl.clone();
    url.pathname = currentWorkspacePath(slug, legacy.rest);
    const redirect = NextResponse.redirect(url, 308);
    // A token refreshed by `getUser()` above was written to `res`; the
    // redirect replaces it, so the cookie has to travel on the redirect or
    // the next request starts from the expired one again.
    for (const cookie of res.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set("server-timing", timing());
    return redirect;
  }

  res.headers.set("server-timing", timing());
  return res;
}

/**
 * Today's slug for a legacy `<a>~<b>` pair, as the person behind the request
 * may see it — or null when the API cannot or will not answer.
 */
async function currentSlugFor(req: NextRequest, ref: string): Promise<string | null> {
  // Read without letting the bundler inline it: the same image runs against
  // any API, so the value has to be the container's, at request time.
  const env: Record<string, string | undefined> = process.env;
  const origin = (env["API_ORIGIN"] ?? "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) headers.set("x-forwarded-host", host);
  try {
    const answer = await fetch(`${origin}/api/workspaces/${encodeURIComponent(ref)}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(LEGACY_LOOKUP_TIMEOUT_MS),
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as Partial<WorkspaceResponse> | null;
    const slug = body?.workspace?.slug;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/w/:path*"],
};
