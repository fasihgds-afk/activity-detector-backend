import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { DateTime } from "luxon";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ MongoDB connection
mongoose
  .connect(
    "mongodb+srv://employee:Employee%402025@cluster0.uzmlw01.mongodb.net/employee_monitor?retryWrites=true&w=majority&appName=Cluster0"
  )
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// ✅ Schemas
const userSchema = new mongoose.Schema({
  name: String,
  department: String,
  shift_start: String,
  shift_end: String,
  created_at: Date,
});

const activitySchema = new mongoose.Schema({
  user: String,
  status: String, // Active / Idle
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

// -------------------------
// Shift Logic
// -------------------------
function assignShift(sessionStart) {
  if (!sessionStart) return { shiftDate: "Unknown", shiftLabel: "General" };

  const dt = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(
    "Asia/Karachi"
  );
  const hour = dt.hour;
  let shiftLabel = "General";
  let shiftDate = dt.startOf("day");

  if (hour >= 18 && hour < 21) {
    shiftLabel = "Shift 1 (6 PM – 3 AM)";
  } else if (hour >= 21 || hour < 6) {
    shiftLabel = "Shift 2 (9 PM – 6 AM)";
    if (hour < 6) {
      shiftDate = shiftDate.minus({ days: 1 });
    }
  }

  return {
    shiftDate: shiftDate.toISODate(),
    shiftLabel,
  };
}

// -------------------------
// API Endpoint
// -------------------------
app.get("/employees", async (req, res) => {
  try {
    const users = await User.find();
    const settings = (await Settings.findOne()) || { general_idle_limit: 60 };

    const results = await Promise.all(
      users.map(async (u) => {
        // 🔹 Idle logs
        const logs = await ActivityLog.find({ user: u.name }).sort({
          timestamp: 1,
        });

        // 🔹 AutoBreak logs
        const abreaks = await AutoBreak.find({ user: u.name }).sort({
          break_start: 1,
        });

        // 🔹 Idle Sessions
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

            const { shiftDate, shiftLabel } = assignShift(start);

            return {
              idle_start: start ? start.toISOString() : null,
              idle_end: end ? end.toISOString() : null,
              start_time_local: start
                ? DateTime.fromJSDate(start, { zone: "utc" })
                    .setZone("Asia/Karachi")
                    .toFormat("HH:mm:ss")
                : "N/A",
              end_time_local: end
                ? DateTime.fromJSDate(end, { zone: "utc" })
                    .setZone("Asia/Karachi")
                    .toFormat("HH:mm:ss")
                : "Ongoing",
              reason: log.reason,
              category: log.category,
              duration,
              shiftDate,
              shiftLabel,
            };
          });

        // 🔹 AutoBreak Sessions (merged into idleSessions)
        const autoBreaks = abreaks.map((br) => {
          const start = br.break_start ? new Date(br.break_start) : null;
          const end = br.break_end ? new Date(br.break_end) : null;

          const { shiftDate, shiftLabel } = assignShift(start);

          return {
            idle_start: start ? start.toISOString() : null,
            idle_end: end ? end.toISOString() : null,
            start_time_local: start
              ? DateTime.fromJSDate(start, { zone: "utc" })
                  .setZone("Asia/Karachi")
                  .toFormat("HH:mm:ss")
              : "N/A",
            end_time_local: end
              ? DateTime.fromJSDate(end, { zone: "utc" })
                  .setZone("Asia/Karachi")
                  .toFormat("HH:mm:ss")
              : "N/A",
            reason: "System Power Off / Startup",
            category: "AutoBreak",
            duration: br.duration_minutes,
            shiftDate,
            shiftLabel,
          };
        });

        return {
          id: u._id,
          name: u.name,
          department: u.department,
          shift_start: u.shift_start,
          shift_end: u.shift_end,
          created_at: u.created_at,
          latest_status:
            logs.length > 0 ? logs[logs.length - 1].status : "Unknown",
          idle_sessions: [...idleSessions, ...autoBreaks], // ✅ merge AutoBreaks with idle
        };
      })
    );

    res.json({ employees: results, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// ✅ Config endpoint
app.get("/config", (req, res) => {
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

// Root
app.get("/", (req, res) => {
  res.send("✅ Employee Monitoring API is running...");
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
