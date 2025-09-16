// routes/activities.js
import express from "express";
import { updateActivity, endActivity, deleteActivity } from "../controllers/activityController.js";
import { authRequired, requireRole } from "../middleware/auth.js";
const router = express.Router();

router.put("/:id", authRequired, requireRole("admin", "superadmin"), updateActivity);
router.put("/:id/end", authRequired, requireRole("admin", "superadmin"), endActivity);
router.delete("/:id", authRequired, requireRole("admin", "superadmin"), deleteActivity);

export default router;
