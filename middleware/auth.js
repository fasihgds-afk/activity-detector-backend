// middleware/auth.js
import jwt from "jsonwebtoken";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function readToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)/i);
  return m ? m[1] : null;
}

export function authRequired(req, res, next) {
  const t = readToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}
