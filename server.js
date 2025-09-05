// server.js
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { DateTime } from "luxon";

/* =========================
   Basic App / Middleware
   ========================= */
const app = express();

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
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

/* =========================
   Schemas / Models
   ========================= */
const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String,
  department: String,
  shift_start: String, // e.g. "6:00 PM" or "18:00"
  shift_end: String,   // e.g. "3:00 AM" or "03:00"
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String,      // usually "Idle"
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
  // optional fields from other ingesters
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

/**
 * Gate used by the frontend to decide whether to show Update/Delete buttons.
 * Keep it 2xx and non-redirect when updates are allowed.
 */
app.get("/update", (_req, res) => {
  res.status(200).json({ ok: true });
});

/* =========================
   Config
   ========================= */
app.get("/config", async (_req, res) => {
  try {
    const s = (await Settings.findOne()) || { general_idle_limit: 60, namaz_limit: 50 };
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
  } catch (e) {
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
   Employees (READ)
   ========================= */
app.get("/employees", async (_req, res) => {
  try {
    const users = await User.find();
    const settings = (await Settings.findOne()) || { general_idle_limit: 60, namaz_limit: 50 };

    const results = await Promise.all(
      users.map(async (u) => {
        const logs    = await ActivityLog.find({ user: u.name }).sort({ timestamp: 1 });
        const abreaks = await AutoBreak.find({ user: u.name }).sort({ break_start: 1 });

        // ----- Idle Sessions from ActivityLogs -----
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
          if (duration == null && start && end) {
            duration = Math.round((end - start) / 60000);
          }
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

        // Merge & sort
        const merged = [...idleSessions, ...autoBreaks].sort((a, b) => {
          const at = a.idle_start ? new Date(a.idle_start).getTime() : 0;
          const bt = b.idle_start ? new Date(b.idle_start).getTime() : 0;
          return at - bt;
        });

        // Flags to help the UI
        const hasOngoingIdle = logs.some(l => l.status === "Idle" && l.idle_start && !l.idle_end);
        const hasOngoingAuto = abreaks.some(b => b.break_start && !b.break_end);

        // Derive better latest status
        const latestStatus = deriveLatestStatus(logs);

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

    res.json({ employees: results, settings });
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

    // allow either Mongo _id or emp_id
    let doc = null;
    try {
      doc = await User.findByIdAndUpdate(id, update, { new: true });
    } catch (_) { /* ignore cast errors */ }
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
    try {
      result = await User.findByIdAndDelete(id);
    } catch (_) { /* ignore cast errors */ }
    if (!result) result = await User.findOneAndDelete({ emp_id: id });

    if (!result) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

/* =========================
   Activity Logs (UPDATE time/reason/category)
   ========================= */
app.put("/activities/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, category, status, idle_start, idle_end } = req.body || {};

    const update = {};
    if (typeof reason === "string") update.reason = reason;
    if (typeof category === "string") update.category = category;
    if (typeof status === "string") update.status = status;
    if (idle_start) {
      const d = new Date(idle_start);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid idle_start" });
      update.idle_start = d;
    }
    if (idle_end !== undefined) {
      if (idle_end === null || idle_end === "") {
        update.idle_end = undefined; // will unset below
      } else {
        const d2 = new Date(idle_end);
        if (isNaN(d2.getTime())) return res.status(400).json({ error: "Invalid idle_end" });
        update.idle_end = d2;
      }
    }

    // Use findById first
    let doc = await ActivityLog.findById(id);
    if (!doc) return res.status(404).json({ error: "Log not found" });

    if (update.reason !== undefined) doc.reason = update.reason;
    if (update.category !== undefined) doc.category = update.category;
    if (update.status !== undefined) doc.status = update.status;
    if (update.idle_start !== undefined) doc.idle_start = update.idle_start;

    if (idle_end !== undefined) {
      if (idle_end === null || idle_end === "") {
        doc.idle_end = undefined; // make it ongoing
      } else {
        doc.idle_end = update.idle_end;
      }
    }

    await doc.save();
    res.json({ ok: true, log: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update activity log" });
  }
});

/* Close an ongoing Idle activity NOW (set idle_end = now) */
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
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
