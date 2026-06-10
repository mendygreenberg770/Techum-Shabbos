// Same-origin proxy for the Overpass API (Vercel serverless function).
//
// For networks whose filters block the public Overpass endpoints: if the
// app's own domain is reachable, this proxy is too. Build the app with
//   VITE_OVERPASS_PROXY=/api/overpass
// and deploy the repo to Vercel — the frontend will then try this route
// first and the building queries run server-side.

const UPSTREAMS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// CommonJS on purpose: the repo's package.json has no "type": "module",
// so this loads correctly on Vercel's Node runtime without extra config.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  // Vercel parses application/x-www-form-urlencoded bodies into an object.
  const body =
    typeof req.body === "string"
      ? req.body
      : new URLSearchParams(req.body ?? {}).toString();
  if (!body.startsWith("data=")) {
    res.status(400).json({ error: "Expected an Overpass form body (data=…)" });
    return;
  }

  let lastStatus = 502;
  let lastText = "No Overpass upstream available";
  for (const upstream of UPSTREAMS) {
    try {
      const r = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      if (r.ok) {
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(text);
        return;
      }
      lastStatus = r.status;
      lastText = text.slice(0, 500);
    } catch (e) {
      lastText = e instanceof Error ? e.message : String(e);
    }
  }
  res.status(lastStatus).json({ error: `All Overpass upstreams failed: ${lastText}` });
};
