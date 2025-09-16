// routes/auth.js
import express from "express";
import { login, me } from "../controllers/authController.js";
import { authRequired } from "../middleware/auth.js";
const router = express.Router();

router.post("/login", express.json(), login);
router.get("/me", authRequired, me);

export default router;
