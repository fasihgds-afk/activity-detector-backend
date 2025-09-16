// models/ActivityLog.js
import mongoose from "mongoose";

const activitySchema = new mongoose.Schema({
  user: String,
  status: String,
  reason: String,
  category: String,
  timestamp: Date,
  idle_start: Date,
  idle_end: Date,
});
activitySchema.index({ user: 1, timestamp: 1 });
activitySchema.index({ user: 1, idle_start: 1 });
activitySchema.index({ user: 1, idle_end: 1 });
activitySchema.index({ user: 1, idle_start: 1, idle_end: 1 });

export default mongoose.model("ActivityLog", activitySchema, "activity_logs");
