// controllers/authController.js
import User from "../models/User.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export async function login(req, res) {
  try {
    const { identifier, password } = req.body || {};
    if (identifier === (process.env.SUPERADMIN_USER || "") && password === (process.env.SUPERADMIN_PASS || "")) {
      const token = signToken({ role: "superadmin", username: identifier });
      return res.json({ ok: true, token, user: { role: "superadmin", username: identifier } });
    }
    if (identifier === (process.env.ADMIN_USER || "") && password === (process.env.ADMIN_PASS || "")) {
      const token = signToken({ role: "admin", username: identifier });
      return res.json({ ok: true, token, user: { role: "admin", username: identifier } });
    }
    const emp = await User.findOne({ emp_id: String(identifier || "").trim() }).lean();
    if (!emp) return res.status(401).json({ error: "Invalid credentials" });
    const token = signToken({ role: "employee", emp_id: emp.emp_id, name: emp.name, userId: String(emp._id) });
    return res.json({ ok: true, token, user: { role: "employee", emp_id: emp.emp_id, name: emp.name, userId: String(emp._id) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
}

export function me(req, res) {
  return res.json({ ok: true, user: req.user });
}
