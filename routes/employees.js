// routes/employees.js
import express from "express";
import { getEmployees, updateEmployee, deleteEmployee } from "../controllers/employeeController.js";
import { authRequired, requireRole } from "../middleware/auth.js";
const router = express.Router();

router.get("/", authRequired, getEmployees);
router.put("/:id", authRequired, requireRole("superadmin"), updateEmployee);
router.delete("/:id", authRequired, requireRole("superadmin"), deleteEmployee);

export default router;
