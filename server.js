import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { DateTime } from "luxon";

const app = express();

/* ============ CORS ============ */
const allowed = (process.env.CORS_ORIGIN || "*").split(",").map(s => s.trim());
app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/* ============ Mongo =========== */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) console.warn("⚠️ MONGODB_URI is not set.");

mongoose
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

/* ============ Schemas ========== */
const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String,
  department: String,
  shift_start: String, // e.g. "6:00 PM"
  shift_end: String,   // e.g. "3:00 AM"
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String,     // usually "Idle"
  reason: String,
  category: String,   // "Official" | "General" | "Namaz"
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
  // some docs (from Python) also have: shiftDate, shiftLabel, break_start_local, break_end_local
  timestamp: { type: Date, default: Date.now },
});

const settingsSchema = new mongoose.Schema({
  general_idle_limit: { type: Number, default: 60 },
  created_at: { type: Date, default: Date.now },
});

/* IMPORTANT: pass real collection names as 3rd arg */
const User        = mongoose.model("User", userSchema, "users");
const ActivityLog = mongoose.model("ActivityLog", activitySchema, "activity_logs");
const AutoBreak   = mongoose.model("AutoBreak", autoBreakSchema, "auto_break_logs");
const Settings    = mongoose.model("Settings", settingsSchema, "settings");

/* ============ Helpers ========== */
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
  // crosses midnight (e.g. 18:00–03:00)
  return m >= s || m <= e;
}

function assignShiftForUser(sessionStart, user) {
  if (!sessionStart) {
    return { shiftDate: "Unknown", shiftLabel: `${user.shift_start} – ${user.shift_end}` };
  }
  const local = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(ZONE);
  const startMin = parseTimeToMinutes(user.shift_start);
  const endMin   = parseTimeToMinutes(user.shift_end);

  if (startMin == null || endMin == null) {
    // Fallback heuristic
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

// Derive a better latest status from activity logs
function deriveLatestStatus(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "Unknown";

  // If there is any ongoing Idle (no idle_end), the user is Idle
  const ongoingIdle = [...logs].reverse().find(l => l.status === "Idle" && l.idle_start && !l.idle_end);
  if (ongoingIdle) return "Idle";

  // If the last Idle is closed (idle_end present), they're Active now
  const lastIdle = [...logs].reverse().find(l => l.status === "Idle" && l.idle_start);
  if (lastIdle && lastIdle.idle_end) return "Active";

  // Else fall back to the very last record's status
  const last = logs[logs.length - 1];
  return last?.status || "Unknown";
}

/* ============ Routes =========== */
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res.send("✅ Employee Monitoring API is running...");
});

app.get("/config", (_req, res) => {
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
});

app.get("/employees", async (_req, res) => {
  try {
    const users = await User.find();
    const settings = (await Settings.findOne()) || { general_idle_limit: 60 };

    const results = await Promise.all(
      users.map(async (u) => {
        const logs    = await ActivityLog.find({ user: u.name }).sort({ timestamp: 1 });
        const abreaks = await AutoBreak.find({ user: u.name }).sort({ break_start: 1 });

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

          let duration = (typeof br.duration_minutes === "number") ? br.duration_minutes : null;
          if (duration == null && start && end) {
            duration = Math.round((end - start) / 60000);
          }
          if (duration == null) duration = 0;

          return {
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

        // Merge & sort by start time
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

/* ========= NEW: helpers to resolve ID (emp_id or _id) ========= */
function isMongoId(s) {
  return /^[0-9a-fA-F]{24}$/.test(String(s || ""));
}
async function findUserByAnyId(id) {
  if (!id) return null;
  if (isMongoId(id)) {
    const byMongo = await User.findById(id);
    if (byMongo) return byMongo;
  }
  return await User.findOne({ emp_id: id });
}

/* ========= NEW: UPDATE employee =========
   PUT /employees/:id
   Body: { name?, department?, shift_start?, shift_end? }
*/
app.put("/employees/:id", async (req, res) => {
  try {
    const u = await findUserByAnyId(req.params.id);
    if (!u) return res.status(404).json({ error: "Employee not found" });

    const { name, department, shift_start, shift_end } = req.body || {};

    if (typeof name === "string") u.name = name.trim();
    if (typeof department === "string") u.department = department.trim();
    if (typeof shift_start === "string") u.shift_start = shift_start.trim();
    if (typeof shift_end === "string") u.shift_end = shift_end.trim();

    await u.save();
    return res.json({ ok: true, employee: u });
  } catch (e) {
    console.error("Update error:", e);
    return res.status(500).json({ error: "Update failed" });
  }
});

/* ========= NEW: DELETE employee =========
   DELETE /employees/:id
*/
app.delete("/employees/:id", async (req, res) => {
  try {
    const u = await findUserByAnyId(req.params.id);
    if (!u) return res.status(404).json({ error: "Employee not found" });

    await User.deleteOne({ _id: u._id });
    // Optional: also clean related logs if you want hard-delete
    // await ActivityLog.deleteMany({ user: u.name });
    // await AutoBreak.deleteMany({ user: u.name });

    return res.json({ ok: true });
  } catch (e) {
    console.error("Delete error:", e);
    return res.status(500).json({ error: "Delete failed" });
  }
});

/* ============ Start ============ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
