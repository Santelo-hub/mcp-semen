docker exec -i mcp-semen sh -lc 'cat > /app/server.js <<'"'"'JS'"'"'
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "5mb" }));

// --- CORS строго под Retell Dashboard ---
const ALLOWED_ORIGINS = new Set([
  "https://dashboard.retellai.com",
  "https://retellai.com"
]);
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // запасной дефолт, чтобы браузер хотя бы показывал JSON руками
    res.setHeader("Access-Control-Allow-Origin", "https://dashboard.retellai.com");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.header("access-control-request-headers") || "*"
  );
  // креды не требуем
  res.setHeader("Access-Control-Allow-Credentials", "false");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- auth-токен (если нужен)
const TOKEN = process.env.MCP_TOKEN || "";
function checkToken(req, res, next) {
  if (!TOKEN) return next();
  const t = req.get("x-mcp-token") || req.query.token;
  if (t !== TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// --- helpers
function readManifest() {
  const p = path.join(__dirname, "manifest.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function sendManifest(res) {
  res.type("application/json");
  res.sendFile(path.join(__dirname, "manifest.json"));
}

// --- Health
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/mcp/health", (_req, res) => res.json({ ok: true }));

// --- Manifest
app.get("/manifest.json", (_req, res) => sendManifest(res));
app.get("/mcp/manifest.json", (_req, res) => sendManifest(res));

// --- Tools (Retell ждёт это)
app.get("/tools", (_req, res) => {
  try { res.json(readManifest().tools || []); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});
app.get("/mcp/tools", (_req, res) => {
  try { res.json(readManifest().tools || []); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// --- База для «капризных» UI: / и /mcp/ вернут список tools
app.get("/", (_req, res) => {
  try { res.json({ ok: true, base: true, tools: readManifest().tools || [] }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});
app.get("/mcp/", (_req, res) => {
  try { res.json({ ok: true, base: true, tools: readManifest().tools || [] }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// --- Action (эхо)
app.post("/action", checkToken, (req, res) => {
  res.json({ ok: true, received_at: new Date().toISOString(), payload: req.body });
});
app.post("/mcp/action", checkToken, (req, res) => {
  res.json({ ok: true, received_at: new Date().toISOString(), payload: req.body });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(\`MCP up on \${port}\`));
JS'

# рестарт только MCP
docker-compose restart mcp-semen
