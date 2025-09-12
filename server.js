// server.js
import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import jwt from "jsonwebtoken";

/* ========================= App / Middleware ========================= */
const app = express();
app.set("etag", false);

// tiny perf log
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms}ms`);
  });
  next();
});

app.use(compression());

// CORS: set exact frontend origin(s) in env as comma-separated list
const allowedOrigins = (process.env.CORS_ORIGIN || "https://activity-detector-admin-panel.vercel.app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/* ========================= MongoDB ========================= */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) console.warn("⚠️ MONGODB_URI is not set.");
mongoose.set("autoIndex", process.env.MONGOOSE_AUTO_INDEX === "true");
mongoose
  .connect(mongoUri, { maxPoolSize: 15 })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

/* ========================= Schemas / Models + Indexes ========================= */
const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String,
  department: String,
  shift_start: String,
  shift_end: String,
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String, // "Idle" | "Active" ...
  reason: String,
  category: String, // "General" | "Official" | "Namaz"
  timestamp: Date,
  idle_start: Date,
  idle_end: Date,
});

const autoBreakSchema = new mongoose.Schema({
  user: String,
  status: { type: String, default: "AutoBreak" },
  break_start: Date,
  break_end: Date,
  duration_minutes: Number,
  shiftDate: String,
  shiftLabel: String,
  break_start_local: String,
  break_end_local: String,
  timestamp: { type: Date, default: Date.now },
});

const settingsSchema = new mongoose.Schema({
  general_idle_limit: { type: Number, default: 60 },
  namaz_limit: { type: Number, default: 50 },
  created_at: { type: Date, default: Date.now },
});

// indexes
userSchema.index({ emp_id: 1 });
userSchema.index({ name: 1 });
activitySchema.index({ user: 1, timestamp: 1 });
activitySchema.index({ user: 1, idle_start: 1 });
activitySchema.index({ user: 1, idle_end: 1 });
activitySchema.index({ user: 1, idle_start: 1, idle_end: 1 }); // compound
autoBreakSchema.index({ user: 1, break_start: 1 });
autoBreakSchema.index({ user: 1, break_end: 1 });

/* collection names */
const User = mongoose.model("User", userSchema, "users");
const ActivityLog = mongoose.model("ActivityLog", activitySchema, "activity_logs");
const AutoBreak = mongoose.model("AutoBreak", autoBreakSchema, "auto_break_logs");
const Settings = mongoose.model("Settings", settingsSchema, "settings");

async function maybeSyncIndexes() {
  if (process.env.SYNC_INDEXES === "true") {
    console.time("syncIndexes");
    await Promise.all([
      User.syncIndexes(),
      ActivityLog.syncIndexes(),
      AutoBreak.syncIndexes(),
      Settings.syncIndexes(),
    ]);
    console.timeEnd("syncIndexes");
    console.log("✅ Indexes synced");
  } else {
    console.log("ℹ️ Skipping syncIndexes (set SYNC_INDEXES=true to run once)");
  }
}
maybeSyncIndexes().catch((e) => console.error("syncIndexes error", e));

/* ========================= Helpers ========================= */
const ZONE = "Asia/Karachi";

function parseTimeToMinutes(str) {
  if (!str) return null;
  const s = String(str).replace(/[–—]/g, "-").trim();
  const formats = ["h:mm a", "h a", "H:mm", "HH:mm"];
  for (const f of formats) {
    const dt = DateTime.fromFormat(s, f, { zone: ZONE });
    if (dt.isValid) return dt.hour * 60 + dt.minute;
  }
  return null;
}

function isInShiftNow(shiftStart, shiftEnd) {
  const s = parseTimeToMinutes(shiftStart);
  const e = parseTimeToMinutes(shiftEnd);
  if (s == null || e == null) return false;
  const now = DateTime.now().setZone(ZONE);
  const m = now.hour * 60 + now.minute;
  if (e >= s) return m >= s && m <= e;
  return m >= s || m <= e; // crosses midnight
}

function assignShiftForUser(sessionStart, user) {
  if (!sessionStart) return { shiftDate: "Unknown", shiftLabel: `${user.shift_start} – ${user.shift_end}` };
  const local = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(ZONE);
  const startMin = parseTimeToMinutes(user.shift_start);
  const endMin = parseTimeToMinutes(user.shift_end);
  if (startMin == null || endMin == null) {
    const hour = local.hour;
    let label = "General";
    let date = local.startOf("day");
    if (hour >= 18 && hour < 21) label = "Shift 1 (6 PM – 3 AM)";
    else if (hour >= 21 || hour < 6) {
      label = "Shift 2 (9 PM – 6 AM)";
      if (hour < 6) date = date.minus({ days: 1 });
    }
    return { shiftDate: date.toISODate(), shiftLabel: label };
  }
  const crossesMidnight = endMin <= startMin;
  const minutesNow = local.hour * 60 + local.minute;
  let date = local.startOf("day");
  if (crossesMidnight && minutesNow < endMin) date = date.minus({ days: 1 });
  return { shiftDate: date.toISODate(), shiftLabel: `${user.shift_start} – ${user.shift_end}` };
}

function deriveLatestStatus(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "Unknown";
  const ongoingIdle = [...logs].reverse().find((l) => l.status === "Idle" && l.idle_start && !l.idle_end);
  if (ongoingIdle) return "Idle";
  const lastIdle = [...logs].reverse().find((l) => l.status === "Idle" && l.idle_start);
  if (lastIdle && lastIdle.idle_end) return "Active";
  const last = logs[logs.length - 1];
  return last?.status || "Unknown";
}

/* ========================= Auth helpers (JWT + RBAC) ========================= */
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}
function readToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)/i);
  return m ? m[1] : null;
}
function authRequired(req, res, next) {
  const t = readToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

/* ========================= Health & Gate ========================= */
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("✅ Employee Monitoring API is running..."));
app.get("/update", (_req, res) => res.status(200).json({ ok: true }));

/* ========================= Auth ========================= */
app.post("/auth/login", express.json(), async (req, res) => {
  try {
    const { identifier, password } = req.body || {};

    // superadmin
    if (identifier === (process.env.SUPERADMIN_USER || "") && password === (process.env.SUPERADMIN_PASS || "")) {
      const token = signToken({ role: "superadmin", username: identifier });
      return res.json({ ok: true, token, user: { role: "superadmin", username: identifier } });
    }

    // admin
    if (identifier === (process.env.ADMIN_USER || "") && password === (process.env.ADMIN_PASS || "")) {
      const token = signToken({ role: "admin", username: identifier });
      return res.json({ ok: true, token, user: { role: "admin", username: identifier } });
    }

    // employee by emp_id (no password)
    const emp = await User.findOne({ emp_id: String(identifier || "").trim() }).lean();
    if (!emp) return res.status(401).json({ error: "Invalid credentials" });
    const token = signToken({ role: "employee", emp_id: emp.emp_id, name: emp.name, userId: String(emp._id) });
    return res.json({ ok: true, token, user: { role: "employee", emp_id: emp.emp_id, name: emp.name, userId: String(emp._id) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", authRequired, (req, res) => res.json({ ok: true, user: req.user }));

/* ========================= Config ========================= */
app.get("/config", async (_req, res) => {
  try {
    const s = (await Settings.findOne().lean()) || { general_idle_limit: 60, namaz_limit: 50 };
    res.json({
      generalIdleLimit: s.general_idle_limit ?? 60,
      namazLimit: s.namaz_limit ?? 50,
      categoryColors: {
        Official: "#3b82f6",
        General: "#f59e0b",
        Namaz: "#10b981",
        AutoBreak: "#ef4444",
      },
    });
  } catch {
    res.json({
      generalIdleLimit: 60,
      namazLimit: 50,
      categoryColors: {
        Official: "#3b82f6",
        General: "#f59e0b",
        Namaz: "#10b981",
        AutoBreak: "#ef4444",
      },
    });
  }
});

/* ========================= Employees (FAST BULK) ========================= */
app.get("/employees", authRequired, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    const DAYS_DEFAULT = 7;
    const DAYS_MAX = 31;

    let { from, to } = req.query || {};
    const now = new Date();
    const ymd = (d) => d.toISOString().slice(0, 10);
    const addDays = (date, n) => {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    };

    if (!from || !to) {
      from = from || ymd(addDays(now, -DAYS_DEFAULT));
      to = to || ymd(now);
    }

    let startISO = new Date(`${from}T00:00:00.000Z`);
    const endISO = new Date(`${to}T23:59:59.999Z`);
    const diffDays = Math.ceil((endISO - startISO) / 86_400_000);
    if (diffDays > DAYS_MAX) startISO = addDays(endISO, -DAYS_MAX);

    // users (RBAC)
    const baseProjection = { name: 1, emp_id: 1, department: 1, shift_start: 1, shift_end: 1, created_at: 1 };
    let userFindQuery = {};
    if (req.user?.role === "employee") userFindQuery = { emp_id: req.user.emp_id };

    const [users, settingsDoc] = await Promise.all([
      User.find(userFindQuery, baseProjection).lean(),
      Settings.findOne().lean(),
    ]);

    const settings = settingsDoc || { general_idle_limit: 60, namaz_limit: 50 };
    if (!users.length) return res.json({ employees: [], settings, range: { from, to } });

    const userNames = users.map((u) => u.name);
    const userSet = new Set(userNames);

    // bulk pull matching logs/autobreaks once
    const [allLogs, allAuto] = await Promise.all([
      ActivityLog.find(
        {
          user: { $in: userNames },
          idle_start: { $lte: endISO },
          $or: [{ idle_end: { $exists: false } }, { idle_end: { $gte: startISO } }],
        },
        { user: 1, status: 1, reason: 1, category: 1, timestamp: 1, idle_start: 1, idle_end: 1 }
      )
        .sort({ user: 1, idle_start: 1 })
        .lean(),
      AutoBreak.find(
        {
          user: { $in: userNames },
          break_start: { $lte: endISO },
          $or: [{ break_end: { $exists: false } }, { break_end: { $gte: startISO } }],
        },
        { user: 1, break_start: 1, break_end: 1, duration_minutes: 1, shiftDate: 1, shiftLabel: 1 }
      )
        .sort({ user: 1, break_start: 1 })
        .lean(),
    ]);

    // group by user
    const logsByUser = new Map(userNames.map((n) => [n, []]));
    const autoByUser = new Map(userNames.map((n) => [n, []]));
    for (const l of allLogs) if (userSet.has(l.user)) logsByUser.get(l.user).push(l);
    for (const a of allAuto) if (userSet.has(a.user)) autoByUser.get(a.user).push(a);

    const employees = users.map((u) => {
      const userLogs = logsByUser.get(u.name) || [];
      const userAuto = autoByUser.get(u.name) || [];

      // transform activity logs -> idle_sessions[]
      const idleSessions = userLogs
        .filter((log) => log.status === "Idle" && log.idle_start)
        .map((log) => {
          const start = log.idle_start ? new Date(log.idle_start) : null;
          const end = log.idle_end ? new Date(log.idle_end) : null;
          const duration = start
            ? end
              ? Math.max(0, Math.round((end - start) / 60000))
              : Math.max(0, Math.round((Date.now() - start) / 60000))
            : 0;

          const { shiftDate, shiftLabel } = assignShiftForUser(start, u);
          return {
            _id: log._id,
            kind: "Idle",
            idle_start: start ? start.toISOString() : null,
            idle_end: end ? end.toISOString() : null,
            start_time_local: start
              ? DateTime.fromJSDate(start, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
              : "N/A",
            end_time_local: end
              ? DateTime.fromJSDate(end, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
              : "Ongoing",
            reason: log.reason,
            category: log.category,
            duration,
            shiftDate,
            shiftLabel,
          };
        });

      // transform autobreaks -> idle_sessions[] of kind=AutoBreak
      const autoBreaks = userAuto.map((br) => {
        const start = br.break_start ? new Date(br.break_start) : null;
        const end = br.break_end ? new Date(br.break_end) : null;
        const assigned = assignShiftForUser(start, u);
        const shiftDate = br.shiftDate || assigned.shiftDate;
        const shiftLabel = br.shiftLabel || assigned.shiftLabel;
        let duration = typeof br.duration_minutes === "number" ? br.duration_minutes : null;
        if (duration == null && start && end) duration = Math.round((end - start) / 60000);
        if (duration == null) duration = 0;

        return {
          _id: br._id,
          kind: "AutoBreak",
          idle_start: start ? start.toISOString() : null,
          idle_end: end ? end.toISOString() : null,
          start_time_local: start
            ? DateTime.fromJSDate(start, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
            : "N/A",
          end_time_local: end
            ? DateTime.fromJSDate(end, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
            : "N/A",
          reason: "System Power Off / Startup",
          category: "AutoBreak",
          duration,
          shiftDate,
          shiftLabel,
        };
      });

      const merged = [...idleSessions, ...autoBreaks].sort((a, b) => {
        const at = a.idle_start ? new Date(a.idle_start).getTime() : 0;
        const bt = b.idle_start ? new Date(b.idle_start).getTime() : 0;
        return at - bt;
      });

      const hasOngoingIdle = userLogs.some(
        (l) => l.status === "Idle" && l.idle_start && !l.idle_end
      );
      const hasOngoingAuto = userAuto.some((b) => b.break_start && !b.break_end);
      const latestStatus = deriveLatestStatus(userLogs);

      return {
        id: u._id,
        emp_id: u.emp_id,
        name: u.name,
        department: u.department,
        shift_start: u.shift_start,
        shift_end: u.shift_end,
        created_at: u.created_at,
        latest_status: latestStatus,
        has_ongoing_idle: hasOngoingIdle,
        has_ongoing_autobreak: hasOngoingAuto,
        is_in_shift_now: isInShiftNow(u.shift_start, u.shift_end),
        idle_sessions: merged,
      };
    });

    return res.json({ employees, settings, range: { from, to } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

/* ========================= Employees (UPDATE / DELETE) ========================= */
app.put("/employees/:id", authRequired, requireRole("superadmin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, department, shift_start, shift_end } = req.body || {};
    const update = {};
    if (typeof name === "string") update.name = name;
    if (typeof department === "string") update.department = department;
    if (typeof shift_start === "string") update.shift_start = shift_start;
    if (typeof shift_end === "string") update.shift_end = shift_end;

    let doc = null;
    try {
      doc = await User.findByIdAndUpdate(id, update, { new: true });
    } catch (_) {}
    if (!doc) doc = await User.findOneAndUpdate({ emp_id: id }, update, { new: true });
    if (!doc) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true, employee: doc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update employee" });
  }
});

app.delete("/employees/:id", authRequired, requireRole("superadmin"), async (req, res) => {
  try {
    const { id } = req.params;
    let result = null;
    try {
      result = await User.findByIdAndDelete(id);
    } catch (_) {}
    if (!result) result = await User.findOneAndDelete({ emp_id: id });
    if (!result) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

/* ========================= Activity Logs (ADMIN or SUPERADMIN) ========================= */
app.put("/activities/:id", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, category, status, idle_start, idle_end } = req.body || {};
    let doc = await ActivityLog.findById(id);
    if (!doc) return res.status(404).json({ error: "Log not found" });

    if (typeof reason === "string") doc.reason = reason;
    if (typeof category === "string") doc.category = category;
    if (typeof status === "string") doc.status = status;

    if (idle_start) {
      const d = new Date(idle_start);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid idle_start" });
      doc.idle_start = d;
    }
    if (idle_end !== undefined) {
      if (idle_end === null || idle_end === "") {
        doc.idle_end = undefined;
      } else {
        const d2 = new Date(idle_end);
        if (isNaN(d2.getTime())) return res.status(400).json({ error: "Invalid idle_end" });
        doc.idle_end = d2;
      }
    }
    await doc.save();
    res.json({ ok: true, log: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update activity log" });
  }
});

app.put("/activities/:id/end", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { id } = req.params;
    const log = await ActivityLog.findById(id);
    if (!log) return res.status(404).json({ error: "Log not found" });
    if (!log.idle_start) return res.status(400).json({ error: "Log has no idle_start" });
    if (log.idle_end) return res.status(400).json({ error: "Log already closed" });
    log.idle_end = new Date();
    await log.save();
    res.json({ ok: true, log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to close activity log" });
  }
});

app.delete("/activities/:id", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ActivityLog.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "Log not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete activity log" });
  }
});

/* ========================= Start Server ========================= */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
server.requestTimeout = 30000;
server.headersTimeout = 65000;


