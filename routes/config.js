// routes/config.js
import express from "express";
import Settings from "../models/Settings.js";
const router = express.Router();

router.get("/config", async (_req, res) => {
  try {
    const s = (await Settings.findOne().lean()) || { general_idle_limit: 60, namaz_limit: 50 };
    res.json({
      generalIdleLimit: s.general_idle_limit ?? 60,
      namazLimit: s.namaz_limit ?? 50,
      categoryColors: {
        Official: "#3b82f6",
        General: "#f59e0b",
        Namaz: "#10b981",
        AutoBreak: "#ef4444",
      },
    });
  } catch {
    res.json({
      generalIdleLimit: 60,
      namazLimit: 50,
      categoryColors: {
        Official: "#3b82f6",
        General: "#f59e0b",
        Namaz: "#10b981",
        AutoBreak: "#ef4444",
      },
    });
  }
});

export default router;
