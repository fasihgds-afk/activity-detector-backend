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
  shift_start: String,
  shift_end: String,
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String,
  reason: String,
  category: String,
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

          // Prefer Python-stored shiftDate/shiftLabel if present
          const assigned = assignShiftForUser(start, u);
          const shiftDate  = br.shiftDate  || assigned.shiftDate;
          const shiftLabel = br.shiftLabel || assigned.shiftLabel;

          // Use saved duration if present; else compute; else 0
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

        return {
          id: u._id,
          emp_id: u.emp_id,
          name: u.name,
          department: u.department,
          shift_start: u.shift_start,
          shift_end: u.shift_end,
          created_at: u.created_at,
          latest_status: logs.length > 0 ? logs[logs.length - 1].status : "Unknown",
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

/* ============ Start ============ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));

