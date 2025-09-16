// models/AutoBreak.js
import mongoose from "mongoose";

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
autoBreakSchema.index({ user: 1, break_start: 1 });
autoBreakSchema.index({ user: 1, break_end: 1 });

export default mongoose.model("AutoBreak", autoBreakSchema, "auto_break_logs");
