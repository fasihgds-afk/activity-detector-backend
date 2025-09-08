// server.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { DateTime } from "luxon";

/* =========================
   Basic App / Middleware
   ========================= */
const app = express();

// kill implicit ETag → avoids slow 304 roundtrips on /employees
app.set("etag", false);

const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

/* =========================
   MongoDB
   ========================= */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) console.warn("⚠️ MONGODB_URI is not set.");

mongoose
  .connect(mongoUri, {
    // modern driver options; pooling helps under burst
    maxPoolSize: 15,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

/* =========================
   Schemas / Models
   ========================= */
const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String,
  department: String,
  shift_start: String, // "6:00 PM" or "18:00"
  shift_end: String,   // "3:00 AM" or "03:00"
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String,      // typically "Idle"
  reason: String,
  category: String,    // "Official" | "General" | "Namaz"
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

/* 🔥 Indexes: make the hot queries fast */
userSchema.index({ emp_id: 1 });
userSchema.index({ name: 1 });

activitySchema.index({ user: 1, timestamp: 1 });
activitySchema.index({ user: 1, idle_start: 1 });
activitySchema.index({ user: 1, idle_end: 1 });

autoBreakSchema.index({ user: 1, break_start: 1 });
autoBreakSchema.index({ user: 1, break_end: 1 });

/* IMPORTANT: pass real collection names as 3rd arg */
const User        = mongoose.model("User", userSchema, "users");
const ActivityLog = mongoose.model("ActivityLog", activitySchema, "activity_logs");
const AutoBreak   = mongoose.model("AutoBreak", autoBreakSchema, "auto_break_logs");
const Settings    = mongoose.model("Settings", settingsSchema, "settings");

/* =========================
   Helpers
   ========================= */
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
  if (!sessionStart) {
    return { shiftDate: "Unknown", shiftLabel: `${user.shift_start} – ${user.shift_end}` };
  }
  const local = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(ZONE);
  const startMin = parseTimeToMinutes(user.shift_start);
  const endMin   = parseTimeToMinutes(user.shift_end);

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
  if (crossesMidnight && minutesNow < endMin) {
    date = date.minus({ days: 1 });
  }
  return { shiftDate: date.toISODate(), shiftLabel: `${user.shift_start} – ${user.shift_end}` };
}

function deriveLatestStatus(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "Unknown";
  const ongoingIdle = [...logs].reverse().find(l => l.status === "Idle" && l.idle_start && !l.idle_end);
  if (ongoingIdle) return "Idle";
  const lastIdle = [...logs].reverse().find(l => l.status === "Idle" && l.idle_start);
  if (lastIdle && lastIdle.idle_end) return "Active";
  const last = logs[logs.length - 1];
  return last?.status || "Unknown";
}

/* =========================
   Health & Gate
   ========================= */
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("✅ Employee Monitoring API is running..."));

/** Gate for frontend edit/delete controls */
app.get("/update", (_req, res) => {
  res.status(200).json({ ok: true });
});

/* =========================
   Config
   ========================= */
app.get("/config", async (_req, res) => {
  try {
    const s = (await Settings.findOne().lean()) || { general_idle_limit: 60, namaz_limit: 50 };
    res.json({
      generalIdleLimit: s.general_idle_limit ?? 60,
      namazLimit: s.namaz_limit ?? 50,
      categoryColors: {
        Official: "#3b82f6",
        General:  "#f59e0b",
        Namaz:    "#10b981",
        AutoBreak:"#ef4444",
      },
    });
  } catch {
    res.json({
      generalIdleLimit: 60,
      namazLimit: 50,
      categoryColors: {
        Official: "#3b82f6",
        General:  "#f59e0b",
        Namaz:    "#10b981",
        AutoBreak:"#ef4444",
      },
    });
  }
});

/* =========================
   Employees (READ) — optimized
   Supports optional ?from=YYYY-MM-DD&to=YYYY-MM-DD
   ========================= */
app.get("/employees", async (req, res) => {
  try {
    // avoid 304 revalidation; always return body
    res.set("Cache-Control", "no-store");

    const { from, to } = req.query || {};
    let range = null;
    if (from && to) {
      const start = new Date(from + "T00:00:00.000Z");
      const end   = new Date(to   + "T23:59:59.999Z");
      range = { start, end };
    }

    const users = await User.find(
      {},
      { name: 1, emp_id: 1, department: 1, shift_start: 1, shift_end: 1, created_at: 1 }
    ).lean();

    const settings = (await Settings.findOne().lean()) || { general_idle_limit: 60, namaz_limit: 50 };

    if (!users.length) {
      return res.json({ employees: [], settings });
    }

    const employees = await Promise.all(
      users.map(async (u) => {
        // build filters (aligned with indexes)
        const logFilter = { user: u.name };
        const abFilter  = { user: u.name };

        if (range) {
          // overlap with selected range
          logFilter.idle_start = { $lte: range.end };
          logFilter.$or = [{ idle_end: { $exists: false } }, { idle_end: { $gte: range.start } }];

          abFilter.break_start = { $lte: range.end };
          abFilter.$or = [{ break_end: { $exists: false } }, { break_end: { $gte: range.start } }];
        }

        // run in parallel, minimal fields, lean() + indexed sorts
        const [logs, abreaks] = await Promise.all([
          ActivityLog.find(
            logFilter,
            { status: 1, reason: 1, category: 1, timestamp: 1, idle_start: 1, idle_end: 1 }
          ).sort({ timestamp: 1 }).lean(),
          AutoBreak.find(
            abFilter,
            { break_start: 1, break_end: 1, duration_minutes: 1, shiftDate: 1, shiftLabel: 1 }
          ).sort({ break_start: 1 }).lean(),
        ]);

        // ----- Idle Sessions -----
        const idleSessions = logs
          .filter((log) => log.status === "Idle" && log.idle_start)
          .map((log) => {
            const start = log.idle_start ? new Date(log.idle_start) : null;
            const end   = log.idle_end ? new Date(log.idle_end) : null;

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
              idle_end:   end ? end.toISOString() : null,
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

        // ----- AutoBreak Sessions -----
        const autoBreaks = abreaks.map((br) => {
          const start = br.break_start ? new Date(br.break_start) : null;
          const end   = br.break_end ? new Date(br.break_end) : null;

          const assigned   = assignShiftForUser(start, u);
          const shiftDate  = br.shiftDate  || assigned.shiftDate;
          const shiftLabel = br.shiftLabel || assigned.shiftLabel;

          let duration = typeof br.duration_minutes === "number" ? br.duration_minutes : null;
          if (duration == null && start && end) duration = Math.round((end - start) / 60000);
          if (duration == null) duration = 0;

          return {
            _id: br._id,
            kind: "AutoBreak",
            idle_start: start ? start.toISOString() : null,
            idle_end:   end ? end.toISOString() : null,
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

        // merge & sort
        const merged = [...idleSessions, ...autoBreaks].sort((a, b) => {
          const at = a.idle_start ? new Date(a.idle_start).getTime() : 0;
          const bt = b.idle_start ? new Date(b.idle_start).getTime() : 0;
          return at - bt;
        });

        const hasOngoingIdle = logs.some(l => l.status === "Idle" && l.idle_start && !l.idle_end);
        const hasOngoingAuto = abreaks.some(b => b.break_start && !b.break_end);
        const latestStatus   = deriveLatestStatus(logs);

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
      })
    );

    res.json({ employees, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

/* =========================
   Employees (UPDATE / DELETE)
   ========================= */
app.put("/employees/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, department, shift_start, shift_end } = req.body || {};
    const update = {};
    if (typeof name === "string") update.name = name;
    if (typeof department === "string") update.department = department;
    if (typeof shift_start === "string") update.shift_start = shift_start;
    if (typeof shift_end === "string") update.shift_end = shift_end;

    let doc = null;
    try { doc = await User.findByIdAndUpdate(id, update, { new: true }); } catch (_) {}
    if (!doc) doc = await User.findOneAndUpdate({ emp_id: id }, update, { new: true });

    if (!doc) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true, employee: doc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update employee" });
  }
});

app.delete("/employees/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let result = null;
    try { result = await User.findByIdAndDelete(id); } catch (_) {}
    if (!result) result = await User.findOneAndDelete({ emp_id: id });
    if (!result) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

/* =========================
   Activity Logs (UPDATE)
   ========================= */
app.put("/activities/:id", async (req, res) => {
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
      if (idle_end === null || idle_end === "") doc.idle_end = undefined;
      else {
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

/* Close an ongoing Idle activity NOW */
app.put("/activities/:id/end", async (req, res) => {
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

/* =========================
   AutoBreaks (CLOSE NOW)
   ========================= */
app.put("/autobreaks/:id/end", async (req, res) => {
  try {
    const { id } = req.params;
    const br = await AutoBreak.findById(id);
    if (!br) return res.status(404).json({ error: "AutoBreak not found" });

    if (!br.break_start) return res.status(400).json({ error: "AutoBreak has no break_start" });
    if (br.break_end) return res.status(400).json({ error: "AutoBreak already closed" });

    const now = new Date();
    br.break_end = now;
    br.duration_minutes = Math.max(0, Math.round((now - br.break_start) / 60000));
    await br.save();
    res.json({ ok: true, autoBreak: br });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to close autobreak" });
  }
});

/* (optional) delete an activity log */
app.delete("/activities/:id", async (req, res) => {
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

/* =========================
   Start Server
   ========================= */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
// Optional: fail fast instead of hanging forever
server.requestTimeout = 30000;
server.headersTimeout = 65000;

