// routes/health.js
import express from "express";
const router = express.Router();

router.get("/healthz", (_req, res) => res.send("ok"));
router.get("/", (_req, res) => res.send("✅ Employee Monitoring API is running..."));
router.get("/update", (_req, res) => res.status(200).json({ ok: true }));

export default router;
