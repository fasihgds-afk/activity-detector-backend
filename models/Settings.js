// models/Settings.js
import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema({
  general_idle_limit: { type: Number, default: 60 },
  namaz_limit: { type: Number, default: 50 },
  created_at: { type: Date, default: Date.now },
});

export default mongoose.model("Settings", settingsSchema, "settings");
