import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { DateTime } from "luxon";

const app = express();

/* =========================
   CORS CONFIG
   ========================= */
// Example while testing: "http://localhost:3000,http://localhost:5173"
// Later add your deployed frontend URL (e.g. "https://your-frontend.vercel.app")
const allowed = (process.env.CORS_ORIGIN || "*").split(",").map(s => s.trim());
app.use(cors({ origin: allowed, credentials: true }));

app.use(express.json({ limit: "1mb" }));

/* =========================
   MONGODB CONNECTION
   ========================= */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) console.warn("⚠️ MONGODB_URI is not set. Configure it in Railway → Environment.");

mongoose
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

/* =========================
   SCHEMAS & MODELS
   ========================= */
const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String, 
  department: String,
  shift_start: String, // e.g. "6 PM" or "18:00"
  shift_end: String,   // e.g. "3 AM" or "03:00"
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String, // "Active" / "Idle"
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
  timestamp: { type: Date, default: Date.now },
});

const settingsSchema = new mongoose.Schema({
  general_idle_limit: { type: Number, default: 60 }, // minutes
  created_at: { type: Date, default: Date.now },
});

const User = mongoose.model("users", userSchema);
const ActivityLog = mongoose.model("activity_logs", activitySchema);
const AutoBreak = mongoose.model("auto_break_logs", autoBreakSchema);
const Settings = mongoose.model("settings", settingsSchema);

/* =========================
   HELPERS
   ========================= */
const ZONE = "Asia/Karachi";

function parseTimeToMinutes(str) {
  if (!str) return null;
  const s = String(str).replace(/[–—]/g, "-").trim(); // normalize dashes
  const formats = ["h:mm a", "h a", "H:mm", "HH:mm"];
  for (const f of formats) {
    const dt = DateTime.fromFormat(s, f, { zone: ZONE });
    if (dt.isValid) return dt.hour * 60 + dt.minute;
  }
  return null; // fallback will handle
}

/**
 * Compute the display label and "shift date" for a session, using the user's assigned shift.
 * shiftDate = the business day the shift belongs to (handles overnight, e.g. 6 PM–3 AM).
 */
function assignShiftForUser(sessionStart, user) {
  if (!sessionStart) {
    return { shiftDate: "Unknown", shiftLabel: `${user.shift_start} – ${user.shift_end}` };
  }

  const local = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(ZONE);
  const minutesNow = local.hour * 60 + local.minute;

  const startMin = parseTimeToMinutes(user.shift_start);
  const endMin = parseTimeToMinutes(user.shift_end);

  // Fallback to old heuristic if parsing failed
  if (startMin == null || endMin == null) {
    const hour = local.hour;
    let label = "General";
    let date = local.startOf("day");
    if (hour >= 18 && hour < 21) {
      label = "Shift 1 (6 PM – 3 AM)";
    } else if (hour >= 21 || hour < 6) {
      label = "Shift 2 (9 PM – 6 AM)";
      if (hour < 6) date = date.minus({ days: 1 });
    }
    return { shiftDate: date.toISODate(), shiftLabel: label };
  }

  const crossesMidnight = endMin <= startMin;
  let date = local.startOf("day");

  if (crossesMidnight) {
    // e.g. 18:00–03:00 ⇒ times between 00:00–02:59 belong to PREVIOUS day of shift
    if (minutesNow < endMin) {
      date = date.minus({ days: 1 });
    }
  } else {
    // Same-day shift: nothing special to do
  }

  return {
    shiftDate: date.toISODate(),
    shiftLabel: `${user.shift_start} – ${user.shift_end}`,
  };
}

/* =========================
   ROUTES
   ========================= */
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res.send("✅ Employee Monitoring API is running...");
});

app.get("/config", (_req, res) => {
  res.json({
    generalIdleLimit: 60,
    categoryColors: {
      Official: "#3b82f6",
      General: "#f59e0b",
      Namaz: "#10b981",
      AutoBreak: "#ef4444",
    },
  });
});

app.get("/employees", async (_req, res) => {
  try {
    const users = await User.find();
    const settings = (await Settings.findOne()) || { general_idle_limit: 60 };

    const results = await Promise.all(
      users.map(async (u) => {
        const logs = await ActivityLog.find({ user: u.name }).sort({ timestamp: 1 });
        const abreaks = await AutoBreak.find({ user: u.name }).sort({ break_start: 1 });

        // Idle Sessions
        const idleSessions = logs
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
              shiftLabel, // <- assigned shift label
            };
          });

        // AutoBreak Sessions
        const autoBreaks = abreaks.map((br) => {
          const start = br.break_start ? new Date(br.break_start) : null;
          const end = br.break_end ? new Date(br.break_end) : null;

          const { shiftDate, shiftLabel } = assignShiftForUser(start, u);

          return {
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
            duration: br.duration_minutes,
            shiftDate,
            shiftLabel, // <- assigned shift label
          };
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
          idle_sessions: [...idleSessions, ...autoBreaks],
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
   START SERVER
   ========================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
