/**
 * Minimal Web-standard NextResponse compatibility shim (zero Next.js dependency).
 */
export class NextResponse extends Response {
  static json(data, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new Response(JSON.stringify(data), {
      ...init,
      headers,
    });
  }

  static redirect(url, status = 307) {
    return new Response(null, {
      status,
      headers: { location: String(url) },
    });
  }
}

export default { NextResponse };
