const express   = require("express");
const cors      = require("cors");
const fs        = require("fs");
const path      = require("path");
const multer    = require("multer");
const cron      = require("node-cron");
const fetch     = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

const CONFIG_PATH   = path.join("/data", "config.json");
const FEEDBACK_PATH = path.join("/data", "feedback.json");
const UPLOADS_DIR   = path.join("/data", "uploads");

// ── Feedback helpers ──────────────────────────────────────────────────────────
function loadFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(FEEDBACK_PATH, "utf8")); }
  catch { return []; }
}
function saveFeedback(list) {
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(list, null, 2));
}

// ... existing config helpers ...
const BACKUPS_DIR  = path.join("/data", "backups");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Multer: bg image uploads ──────────────────────────────────────────────────
const imgStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `bg_${Date.now()}${ext}`);
  },
});
const uploadImg = multer({
  storage:    imgStorage,
  limits:     { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error("Images only")),
});

// ── Multer: import JSON uploads ───────────────────────────────────────────────
const jsonStorage = multer.memoryStorage();
const uploadJson  = multer({
  storage:    jsonStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    (file.mimetype === "application/json" || file.originalname.endsWith(".json"))
      ? cb(null, true) : cb(new Error("JSON files only")),
});

// ── Optional admin token ──────────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.headers["authorization"] === `Bearer ${ADMIN_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}
function saveConfig(cfg) {
  fs.mkdirSync("/data", { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Backup helpers ────────────────────────────────────────────────────────────
function makeBackup() {
  const cfg = loadConfig();
  if (!cfg) return null;
  // Strip the HA token from the backup
  const { token: _omit, ...safe } = cfg;
  const ts   = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUPS_DIR, `backup_${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(safe, null, 2));
  // Keep only the 20 most recent backups
  const all = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith("backup_") && f.endsWith(".json"))
    .sort();
  while (all.length > 20) {
    fs.unlinkSync(path.join(BACKUPS_DIR, all.shift()));
  }
  return path.basename(file);
}

function listBackups() {
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith("backup_") && f.endsWith(".json"))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { filename: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
}

// ── Cron scheduler ────────────────────────────────────────────────────────────
let activeCronJob = null;

function applyCron(expression) {
  if (activeCronJob) { activeCronJob.stop(); activeCronJob = null; }
  if (!expression || expression === "off") return;
  if (!cron.validate(expression)) {
    console.warn(`Invalid cron expression ignored: "${expression}"`);
    return;
  }
  activeCronJob = cron.schedule(expression, () => {
    const name = makeBackup();
    if (name) console.log(`Scheduled backup: ${name}`);
  });
  console.log(`Backup cron set: "${expression}"`);
}

// Boot: restore cron from saved config
(function initCron() {
  const cfg = loadConfig();
  if (cfg?.backupCron) applyCron(cfg.backupCron);
})();

// ── Static: uploads & backups ─────────────────────────────────────────────────
app.use("/uploads", express.static(UPLOADS_DIR));
// Backups are served through an authenticated endpoint, not statically

// ── Admin: upload bg image ────────────────────────────────────────────────────
app.post("/api/admin/upload-bg", requireAdmin, uploadImg.single("bg"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  const cfg = loadConfig() || {};
  if (cfg.layout?.bgUpload && cfg.layout.bgUpload !== req.file.filename) {
    const old = path.join(UPLOADS_DIR, cfg.layout.bgUpload);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  res.json({ ok: true, url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

// ── Admin: login ──────────────────────────────────────────────────────────────
app.post("/api/admin/login", requireAdmin, async (req, res) => {
  const { haUrl, token, useExisting } = req.body;
  if (!haUrl) return res.status(400).json({ error: "haUrl required" });
  const base = haUrl.replace(/\/$/, "");
  const cfg  = loadConfig() || {};
  const effectiveToken = token || (useExisting ? cfg.token : null);
  if (!effectiveToken) return res.status(400).json({ error: "No token provided and none saved" });
  try {
    const r = await fetch(`${base}/api/`, { headers: { Authorization: `Bearer ${effectiveToken}` } });
    if (!r.ok) return res.status(401).json({ error: "HA rejected the token" });
    const data = await r.json();
    cfg.haUrl = base;
    if (token) cfg.token = token;
    saveConfig(cfg);
    res.json({ ok: true, message: data.message });
  } catch (e) {
    res.status(502).json({ error: `Cannot reach HA: ${e.message}` });
  }
});

// ── Admin: entities ───────────────────────────────────────────────────────────
app.get("/api/admin/entities", requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.status(401).json({ error: "Not configured" });
  try {
    const r = await fetch(`${cfg.haUrl}/api/states`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const states = await r.json();
    res.json(states.map(s => ({ entity_id: s.entity_id, state: s.state, attributes: s.attributes })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/admin/services", requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.status(401).json({ error: "Not configured" });
  try {
    const r = await fetch(`${cfg.haUrl}/api/services`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const services = await r.json();
    res.json(services);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// ── Admin: save layout ────────────────────────────────────────────────────────
app.post("/api/admin/layout", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.status(401).json({ error: "Not configured" });
  const { items, gridCols, title, font, bgImage, bgUpload, analyticsCode, backupCron, colorMode, notifyEntity } = req.body;
  cfg.layout = {
    items:         items || [],
    gridCols:      gridCols || 3,
    title:         title || "Home",
    font:          font || "",
    bgImage:       bgImage || "",
    bgUpload:      bgUpload || "",
    analyticsCode: analyticsCode || "",
    colorMode:     colorMode || "dark",
    notifyEntity:  notifyEntity || "",
  };
  cfg.exposedEntities = (items || []).filter(i => i.type === "entity");
  // Save and apply cron separately (not inside layout)
  if (backupCron !== undefined) {
    cfg.backupCron = backupCron;
    applyCron(backupCron);
  }
  saveConfig(cfg);
  res.json({ ok: true, count: items.length });
});

// ── Admin: feedback management ────────────────────────────────────────────────
app.get("/api/admin/feedback", requireAdmin, (req, res) => {
  res.json(loadFeedback());
});

app.delete("/api/admin/feedback/:id", requireAdmin, (req, res) => {
  const list = loadFeedback();
  const filtered = list.filter(f => f.id !== req.params.id);
  saveFeedback(filtered);
  res.json({ ok: true });
});

// ── Public: submit feedback ───────────────────────────────────────────────────
app.post("/api/public/feedback", async (req, res) => {
  const { text } = req.body;
  if (!text || text.length > 250) return res.status(400).json({ error: "Invalid text" });

  const cfg = loadConfig();
  const feedback = {
    id: Date.now().toString(36),
    ts: new Date().toISOString(),
    ip: req.ip || req.headers["x-forwarded-for"] || "unknown",
    text: text.trim(),
    likes: 0,
  };

  const list = loadFeedback();
  list.unshift(feedback);
  saveFeedback(list);

  // Notify HA
  if (cfg?.layout?.notifyEntity && cfg.haUrl && cfg.token) {
    try {
      const domain = cfg.layout.notifyEntity.split(".")[0];
      const service = cfg.layout.notifyEntity.split(".")[1];
      const shortText = text.length > 100 ? text.substring(0, 97) + "..." : text;

      await fetch(`${cfg.haUrl}/api/services/${domain}/${service}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          title: "New Dashboard Feedback", 
          message: `From ${feedback.ip}: ${shortText}` 
        }),
      });
    } catch (e) {
      console.warn("Feedback notification failed:", e.message);
    }
  }

  res.json({ ok: true });
});


// ── Public: guestbook ─────────────────────────────────────────────────────────
app.get("/api/public/guestbook", (req, res) => {
  const list = loadFeedback();
  res.json(list.map(({ ip: _ip, ...rest }) => rest));
});

app.post("/api/public/guestbook/:id/like", (req, res) => {
  const list = loadFeedback();
  const entry = list.find(f => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  entry.likes = (entry.likes || 0) + 1;
  saveFeedback(list);
  res.json({ ok: true, likes: entry.likes });
});

// ── Admin: get layout ─────────────────────────────────────────────────────────
app.get("/api/admin/layout", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  const layout = cfg?.layout || { items: [], gridCols: 3 };
  res.json({ ...layout, backupCron: cfg?.backupCron || "off" });
});

// ── Admin: status ─────────────────────────────────────────────────────────────
app.get("/api/admin/status", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.json({ configured: false });
  const bgUpload   = cfg.layout?.bgUpload || "";
  const resolvedBg = bgUpload ? `/uploads/${bgUpload}` : (cfg.layout?.bgImage || "");
  res.json({
    configured:    true,
    haUrl:         cfg.haUrl,
    itemCount:     cfg.layout?.items?.length || 0,
    title:         cfg.layout?.title  || "Home",
    font:          cfg.layout?.font   || "",
    bgImage:       cfg.layout?.bgImage || "",
    bgUpload:      bgUpload,
    resolvedBg:    resolvedBg,
    analyticsCode: cfg.layout?.analyticsCode || "",
    backupCron:    cfg.backupCron || "off",
  });
});

// ── Admin: export config (no token) ──────────────────────────────────────────
app.get("/api/admin/export", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  if (!cfg) return res.status(404).json({ error: "No config to export" });
  const { token: _omit, ...safe } = cfg;
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="ha-public-dash-${ts}.json"`);
  res.send(JSON.stringify(safe, null, 2));
});

// ── Admin: import config ──────────────────────────────────────────────────────
app.post("/api/admin/import", requireAdmin, uploadJson.single("config"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  let imported;
  try {
    imported = JSON.parse(req.file.buffer.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  const current = loadConfig() || {};
  // Merge: keep existing token, overwrite everything else
  const merged = {
    ...imported,
    token: current.token,        // never overwrite the live token from import
    haUrl: imported.haUrl || current.haUrl,
  };
  saveConfig(merged);
  // Re-apply cron if imported one
  if (merged.backupCron) applyCron(merged.backupCron);
  res.json({ ok: true, itemCount: merged.layout?.items?.length || 0 });
});

// ── Admin: manual backup now ──────────────────────────────────────────────────
app.post("/api/admin/backup", requireAdmin, (req, res) => {
  const name = makeBackup();
  if (!name) return res.status(500).json({ error: "Nothing to back up" });
  res.json({ ok: true, filename: name });
});

// ── Admin: list backups ───────────────────────────────────────────────────────
app.get("/api/admin/backups", requireAdmin, (req, res) => {
  res.json(listBackups());
});

// ── Admin: download a backup ──────────────────────────────────────────────────
app.get("/api/admin/backups/:filename", requireAdmin, (req, res) => {
  const file = path.join(BACKUPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(file)}"`);
  res.setHeader("Content-Type", "application/json");
  res.sendFile(file);
});

// ── Admin: delete a backup ────────────────────────────────────────────────────
app.delete("/api/admin/backups/:filename", requireAdmin, (req, res) => {
  const file = path.join(BACKUPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ── Public: layout ────────────────────────────────────────────────────────────
app.get("/api/public/layout", async (req, res) => {
  const cfg    = loadConfig();
  const layout = cfg?.layout || { items: [], gridCols: 3 };
  const bgUpload   = layout.bgUpload || "";
  const resolvedBg = bgUpload ? `/uploads/${bgUpload}` : (layout.bgImage || "");
  if (!layout.items.length) {
    const { analyticsCode: _a, ...safe } = layout;
    return res.json({ ...safe, resolvedBg });
  }
  const entityItems = layout.items.filter(i => (i.type === "entity" || i.type === "gauge") && i.entity_id);
  const subEntities = layout.items.filter(i => i.sub_entity_id).map(i => i.sub_entity_id);
  const allNeededIds = [...new Set([...entityItems.map(e => e.entity_id), ...subEntities])];

  try {
    const states = await Promise.all(
      allNeededIds.map(async eid => {
        const r = await fetch(`${cfg.haUrl}/api/states/${eid}`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
        });
        const s = await r.json();
        return { entity_id: eid, state: s.state, attributes: s.attributes };
      })
    );
    const stateMap = Object.fromEntries(states.map(s => [s.entity_id, s]));
    const items = layout.items.map(item => {
      let processed = { ...item };
      if ((item.type === "entity" || item.type === "gauge") && item.entity_id) {
        const live = stateMap[item.entity_id] || {};
        processed.state = live.state;
        processed.attributes = live.attributes;
      }
      if (item.sub_entity_id) {
        const subLive = stateMap[item.sub_entity_id] || {};
        processed.sub_state = subLive.state;
        processed.sub_attributes = subLive.attributes;
      }
      return processed;
    });
    const { analyticsCode: _s, ...safeLayout } = layout;
    res.json({ ...safeLayout, resolvedBg, items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Public: trigger action ────────────────────────────────────────────────────
app.post("/api/public/action/:entity_id", async (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.status(503).json({ error: "Not configured" });
  const { entity_id } = req.params;
  const allItems = cfg?.layout?.items || cfg?.exposedEntities || [];
  const exposed  = allItems.find(e => e.entity_id === entity_id);
  if (!exposed) return res.status(403).json({ error: "Entity not exposed" });
  const domain      = entity_id.split(".")[0];
  const service     = exposed.service || "toggle";
  const serviceData = exposed.service_data || { entity_id };
  try {
    const r = await fetch(`${cfg.haUrl}/api/services/${domain}/${service}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(serviceData),
    });
    res.json({ ok: true, result: await r.json() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Legacy ────────────────────────────────────────────────────────────────────
app.post("/api/admin/expose", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  if (!cfg?.haUrl) return res.status(401).json({ error: "Not configured" });
  const { entities } = req.body;
  cfg.exposedEntities  = entities;
  cfg.layout           = cfg.layout || {};
  cfg.layout.items     = entities.map(e => ({ ...e, type: "entity" }));
  saveConfig(cfg);
  res.json({ ok: true, count: entities.length });
});

app.get("/api/public/entities", async (req, res) => {
  const cfg   = loadConfig();
  const items = cfg?.layout?.items || cfg?.exposedEntities || [];
  const entityItems = items.filter(i => !i.type || i.type === "entity");
  if (!entityItems.length) return res.json([]);
  try {
    const states = await Promise.all(
      entityItems.map(async e => {
        const r = await fetch(`${cfg.haUrl}/api/states/${e.entity_id}`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
        });
        const s = await r.json();
        return { ...e, state: s.state, attributes: s.attributes };
      })
    );
    res.json(states);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── Static ────────────────────────────────────────────────────────────────────
app.use("/admin", express.static("/app/admin"));

app.get("/", (req, res) => {
  const cfg           = loadConfig();
  const analyticsCode = cfg?.layout?.analyticsCode || "";
  let html = fs.readFileSync("/app/frontend/index.html", "utf8");
  html = html.replace("<!-- ANALYTICS_PLACEHOLDER -->", analyticsCode);
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

app.use("/", express.static("/app/frontend"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`HA-Public-Dash on :${PORT} | admin token: ${ADMIN_TOKEN ? "set" : "none"} | cron: ${loadConfig()?.backupCron || "off"}`)
);
