// server.js

// server.js
import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";
import dotenv from "dotenv";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import configRoutes from "./routes/config.js";
import employeeRoutes from "./routes/employees.js";
import activityRoutes from "./routes/activities.js";
dotenv.config();
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

/* ========================= MongoDB ========================= */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) console.warn("⚠️ MONGODB_URI is not set.");
mongoose.set("autoIndex", process.env.MONGOOSE_AUTO_INDEX === "true");
mongoose
  .connect(mongoUri, { maxPoolSize: 15 })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

// Sync indexes if needed
async function maybeSyncIndexes() {
  if (process.env.SYNC_INDEXES === "true") {
    console.time("syncIndexes");
    const { default: User } = await import("./models/User.js");
    const { default: ActivityLog } = await import("./models/ActivityLog.js");
    const { default: AutoBreak } = await import("./models/AutoBreak.js");
    const { default: Settings } = await import("./models/Settings.js");
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

/* ========================= Routes ========================= */
app.use("/", healthRoutes);
app.use("/auth", authRoutes);
app.use("/config", configRoutes);
app.use("/employees", employeeRoutes);
app.use("/activities", activityRoutes);

/* ========================= Start Server ========================= */
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
server.requestTimeout = 30000;
server.headersTimeout = 65000;
server.requestTimeout = 30000;
server.headersTimeout = 65000;


