// controllers/activityController.js
import ActivityLog from "../models/ActivityLog.js";

export async function updateActivity(req, res) {
  try {
    const { id } = req.params;
    const { reason, category, status, idle_start, idle_end } = req.body || {};
    let doc = await ActivityLog.findById(id);
    if (!doc) return res.status(404).json({ error: "Log not found" });
    if (typeof reason === "string") doc.reason = reason;
    if (typeof category === "string") doc.category = category;
    if (typeof status === "string") doc.status = status;
    if (idle_start) {
      const d = new Date(idle_start);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid idle_start" });
      doc.idle_start = d;
    }
    if (idle_end !== undefined) {
      if (idle_end === null || idle_end === "") {
        doc.idle_end = undefined;
      } else {
        const d2 = new Date(idle_end);
        if (isNaN(d2.getTime())) return res.status(400).json({ error: "Invalid idle_end" });
        doc.idle_end = d2;
      }
    }
    await doc.save();
    res.json({ ok: true, log: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update activity log" });
  }
}

export async function endActivity(req, res) {
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
}

export async function deleteActivity(req, res) {
  try {
    const { id } = req.params;
    const deleted = await ActivityLog.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "Log not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete activity log" });
  }
}
