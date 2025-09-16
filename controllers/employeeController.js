// controllers/employeeController.js
import User from "../models/User.js";
import ActivityLog from "../models/ActivityLog.js";
import AutoBreak from "../models/AutoBreak.js";
import Settings from "../models/Settings.js";
import { DateTime } from "luxon";

const ZONE = "Asia/Karachi";

function parseTimeToMinutes(str) {
  if (!str) return null;
  const s = String(str).replace(/[–—]/g, "-").trim();
  const formats = ["h:mm a", "h a", "H:mm", "HH:mm"];
  for (const f of formats) {
    const dt = DateTime.fromFormat(s, f, { zone: ZONE });
    if (dt.isValid) return dt.hour * 60 + dt.minute;
  }
  return null;
}

function isInShiftNow(shiftStart, shiftEnd) {
  const s = parseTimeToMinutes(shiftStart);
  const e = parseTimeToMinutes(shiftEnd);
  if (s == null || e == null) return false;
  const now = DateTime.now().setZone(ZONE);
  const m = now.hour * 60 + now.minute;
  if (e >= s) return m >= s && m <= e;
  return m >= s || m <= e;
}

function assignShiftForUser(sessionStart, user) {
  if (!sessionStart) return { shiftDate: "Unknown", shiftLabel: `${user.shift_start} – ${user.shift_end}` };
  const local = DateTime.fromJSDate(sessionStart, { zone: "utc" }).setZone(ZONE);
  const startMin = parseTimeToMinutes(user.shift_start);
  const endMin = parseTimeToMinutes(user.shift_end);
  if (startMin == null || endMin == null) {
    const hour = local.hour;
    let label = "General";
    let date = local.startOf("day");
    if (hour >= 18 && hour < 21) label = "Shift 1 (6 PM – 3 AM)";
    else if (hour >= 21 || hour < 6) {
      label = "Shift 2 (9 PM – 6 AM)";
      if (hour < 6) date = date.minus({ days: 1 });
    }
    return { shiftDate: date.toISODate(), shiftLabel: label };
  }
  const crossesMidnight = endMin <= startMin;
  const minutesNow = local.hour * 60 + local.minute;
  let date = local.startOf("day");
  if (crossesMidnight && minutesNow < endMin) date = date.minus({ days: 1 });
  return { shiftDate: date.toISODate(), shiftLabel: `${user.shift_start} – ${user.shift_end}` };
}

function deriveLatestStatus(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return "Unknown";
  const ongoingIdle = [...logs].reverse().find((l) => l.status === "Idle" && l.idle_start && !l.idle_end);
  if (ongoingIdle) return "Idle";
  const lastIdle = [...logs].reverse().find((l) => l.status === "Idle" && l.idle_start);
  if (lastIdle && lastIdle.idle_end) return "Active";
  const last = logs[logs.length - 1];
  return last?.status || "Unknown";
}

export async function getEmployees(req, res) {
  try {
    res.set("Cache-Control", "no-store");
    const DAYS_DEFAULT = 7;
    const DAYS_MAX = 31;
    let { from, to } = req.query || {};
    const now = new Date();
    const ymd = (d) => d.toISOString().slice(0, 10);
    const addDays = (date, n) => {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    };
    if (!from || !to) {
      from = from || ymd(addDays(now, -DAYS_DEFAULT));
      to = to || ymd(now);
    }
    let startISO = new Date(`${from}T00:00:00.000Z`);
    const endISO = new Date(`${to}T23:59:59.999Z`);
    const diffDays = Math.ceil((endISO - startISO) / 86_400_000);
    if (diffDays > DAYS_MAX) startISO = addDays(endISO, -DAYS_MAX);
    const baseProjection = { name: 1, emp_id: 1, department: 1, shift_start: 1, shift_end: 1, created_at: 1 };
    let userFindQuery = {};
    if (req.user?.role === "employee") userFindQuery = { emp_id: req.user.emp_id };
    const [users, settingsDoc] = await Promise.all([
      User.find(userFindQuery, baseProjection).lean(),
      Settings.findOne().lean(),
    ]);
    const settings = settingsDoc || { general_idle_limit: 60, namaz_limit: 50 };
    if (!users.length) return res.json({ employees: [], settings, range: { from, to } });
    const userNames = users.map((u) => u.name);
    const userSet = new Set(userNames);
    const [allLogs, allAuto] = await Promise.all([
      ActivityLog.find(
        {
          user: { $in: userNames },
          idle_start: { $lte: endISO },
          $or: [{ idle_end: { $exists: false } }, { idle_end: { $gte: startISO } }],
        },
        { user: 1, status: 1, reason: 1, category: 1, timestamp: 1, idle_start: 1, idle_end: 1 }
      )
        .sort({ user: 1, idle_start: 1 })
        .lean(),
      AutoBreak.find(
        {
          user: { $in: userNames },
          break_start: { $lte: endISO },
          $or: [{ break_end: { $exists: false } }, { break_end: { $gte: startISO } }],
        },
        { user: 1, break_start: 1, break_end: 1, duration_minutes: 1, shiftDate: 1, shiftLabel: 1 }
      )
        .sort({ user: 1, break_start: 1 })
        .lean(),
    ]);
    const logsByUser = new Map(userNames.map((n) => [n, []]));
    const autoByUser = new Map(userNames.map((n) => [n, []]));
    for (const l of allLogs) if (userSet.has(l.user)) logsByUser.get(l.user).push(l);
    for (const a of allAuto) if (userSet.has(a.user)) autoByUser.get(a.user).push(a);
    const employees = users.map((u) => {
      const userLogs = logsByUser.get(u.name) || [];
      const userAuto = autoByUser.get(u.name) || [];
      const idleSessions = userLogs
        .filter((log) => log.status === "Idle" && log.idle_start)
        .map((log) => {
          const start = log.idle_start ? new Date(log.idle_start) : null;
          const end = log.idle_end ? new Date(log.idle_end) : null;
          const duration = start
            ? end
              ? Math.max(0, Math.round((end - start) / 60000))
              : Math.max(0, Math.round((Date.now() - start) / 60000))
            : 0;
          const { shiftDate, shiftLabel } = assignShiftForUser(start, u);
          return {
            _id: log._id,
            kind: "Idle",
            idle_start: start ? start.toISOString() : null,
            idle_end: end ? end.toISOString() : null,
            start_time_local: start
              ? DateTime.fromJSDate(start, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
              : "N/A",
            end_time_local: end
              ? DateTime.fromJSDate(end, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
              : "Ongoing",
            reason: log.reason,
            category: log.category,
            duration,
            shiftDate,
            shiftLabel,
          };
        });
      const autoBreaks = userAuto.map((br) => {
        const start = br.break_start ? new Date(br.break_start) : null;
        const end = br.break_end ? new Date(br.break_end) : null;
        const assigned = assignShiftForUser(start, u);
        const shiftDate = br.shiftDate || assigned.shiftDate;
        const shiftLabel = br.shiftLabel || assigned.shiftLabel;
        let duration = typeof br.duration_minutes === "number" ? br.duration_minutes : null;
        if (duration == null && start && end) duration = Math.round((end - start) / 60000);
        if (duration == null) duration = 0;
        return {
          _id: br._id,
          kind: "AutoBreak",
          idle_start: start ? start.toISOString() : null,
          idle_end: end ? end.toISOString() : null,
          start_time_local: start
            ? DateTime.fromJSDate(start, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
            : "N/A",
          end_time_local: end
            ? DateTime.fromJSDate(end, { zone: "utc" }).setZone(ZONE).toFormat("HH:mm:ss")
            : "N/A",
          reason: "System Power Off / Startup",
          category: "AutoBreak",
          duration,
          shiftDate,
          shiftLabel,
        };
      });
      const merged = [...idleSessions, ...autoBreaks].sort((a, b) => {
        const at = a.idle_start ? new Date(a.idle_start).getTime() : 0;
        const bt = b.idle_start ? new Date(b.idle_start).getTime() : 0;
        return at - bt;
      });
      const hasOngoingIdle = userLogs.some(
        (l) => l.status === "Idle" && l.idle_start && !l.idle_end
      );
      const hasOngoingAuto = userAuto.some((b) => b.break_start && !b.break_end);
      const latestStatus = deriveLatestStatus(userLogs);
      return {
        id: u._id,
        emp_id: u.emp_id,
        name: u.name,
        department: u.department,
        shift_start: u.shift_start,
        shift_end: u.shift_end,
        created_at: u.created_at,
        latest_status: latestStatus,
        has_ongoing_idle: hasOngoingIdle,
        has_ongoing_autobreak: hasOngoingAuto,
        is_in_shift_now: isInShiftNow(u.shift_start, u.shift_end),
        idle_sessions: merged,
      };
    });
    return res.json({ employees, settings, range: { from, to } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
}

export async function updateEmployee(req, res) {
  try {
    const { id } = req.params;
    const { name, department, shift_start, shift_end } = req.body || {};
    const update = {};
    if (typeof name === "string") update.name = name;
    if (typeof department === "string") update.department = department;
    if (typeof shift_start === "string") update.shift_start = shift_start;
    if (typeof shift_end === "string") update.shift_end = shift_end;
    let doc = null;
    try {
      doc = await User.findByIdAndUpdate(id, update, { new: true });
    } catch (_) {}
    if (!doc) doc = await User.findOneAndUpdate({ emp_id: id }, update, { new: true });
    if (!doc) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true, employee: doc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update employee" });
  }
}

export async function deleteEmployee(req, res) {
  try {
    const { id } = req.params;
    let result = null;
    try {
      result = await User.findByIdAndDelete(id);
    } catch (_) {}
    if (!result) result = await User.findOneAndDelete({ emp_id: id });
    if (!result) return res.status(404).json({ error: "Employee not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete employee" });
  }
}
