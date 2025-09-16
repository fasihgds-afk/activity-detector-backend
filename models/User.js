// models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  emp_id: String,
  department: String,
  shift_start: String,
  shift_end: String,
  created_at: Date,
});
userSchema.index({ emp_id: 1 });
userSchema.index({ name: 1 });

export default mongoose.model("User", userSchema, "users");
