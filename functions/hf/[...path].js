export async function onRequest({ params, request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const path = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const targetUrl = `https://huggingface.co/${path}`;

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") || "terapeuta-app",
      Accept: request.headers.get("Accept") || "*/*",
    },
  });

  const headers = new Headers(upstream.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");

  // Cache model assets aggressively at edge
  if (
    path.endsWith(".onnx") ||
    path.endsWith(".wasm") ||
    path.endsWith(".json") ||
    path.endsWith(".txt")
  ) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
