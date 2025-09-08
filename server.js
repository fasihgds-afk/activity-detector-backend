/* =========================
   Employees (READ) — fast + 7-day default window
   - Default window: last 7 days
   - Hard cap: max 31 days per request
   - Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD
   ========================= */
app.get("/employees", async (req, res) => {
  try {
    // never 304; always send body to avoid long revalidation stalls
    res.set("Cache-Control", "no-store");

    // ---- window selection & capping ----
    const DAYS_DEFAULT = 7;   // change to 30 after indexes are confirmed if you want
    const DAYS_MAX = 31;      // hard ceiling to protect the server

    let { from, to } = req.query || {};
    const now = new Date();

    function ymd(d) {
      return d.toISOString().slice(0, 10);
    }
    function addDays(date, n) {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    }

    if (!from || !to) {
      const start = addDays(now, -DAYS_DEFAULT);
      from = from || ymd(start);
      to   = to   || ymd(now);
    }

    // hard cap: if the requested span is > DAYS_MAX, clamp it
    const startISO = new Date(from + "T00:00:00.000Z");
    const endISO   = new Date(to   + "T23:59:59.999Z");
    const diffDays = Math.ceil((endISO - startISO) / (24 * 3600 * 1000));
    if (diffDays > DAYS_MAX) {
      // clamp start to keep the most recent DAYS_MAX
      const clampedStart = addDays(endISO, -DAYS_MAX);
      from = ymd(clampedStart);
    }

    const range = {
      start: new Date(from + "T00:00:00.000Z"),
      end:   new Date(to   + "T23:59:59.999Z"),
    };

    // ---- fetch users & settings (lean + projection) ----
    const [users, settingsDoc] = await Promise.all([
      User.find(
        {},
        { name: 1, emp_id: 1, department: 1, shift_start: 1, shift_end: 1, created_at: 1 }
      ).lean(),
      Settings.findOne().lean()
    ]);
    const settings = settingsDoc || { general_idle_limit: 60, namaz_limit: 50 };

    if (!users.length) {
      return res.json({ employees: [], settings, range: { from, to } });
    }

    // ---- build employees payload ----
    const employees = await Promise.all(
      users.map(async (u) => {
        // overlap filters (aligns with indexes suggested earlier)
        const logFilter = {
          user: u.name,
          idle_start: { $lte: range.end },
          $or: [{ idle_end: { $exists: false } }, { idle_end: { $gte: range.start } }],
        };
        const abFilter = {
          user: u.name,
          break_start: { $lte: range.end },
          $or: [{ break_end: { $exists: false } }, { break_end: { $gte: range.start } }],
        };

        // parallel queries + lean + projection + indexed sorts
        const [logs, abreaks] = await Promise.all([
          ActivityLog.find(
            logFilter,
            { status: 1, reason: 1, category: 1, timestamp: 1, idle_start: 1, idle_end: 1 }
          ).sort({ timestamp: 1 }).lean(),
          AutoBreak.find(
            abFilter,
            { break_start: 1, break_end: 1, duration_minutes: 1, shiftDate: 1, shiftLabel: 1 }
          ).sort({ break_start: 1 }).lean(),
        ]);

        // ----- transform: Idle -----
        const idleSessions = logs
          .filter((log) => log.status === "Idle" && log.idle_start)
          .map((log) => {
            const start = log.idle_start ? new Date(log.idle_start) : null;
            const end   = log.idle_end ? new Date(log.idle_end) : null;

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
              idle_end:   end ? end.toISOString() : null,
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

        // ----- transform: AutoBreak -----
        const autoBreaks = abreaks.map((br) => {
          const start = br.break_start ? new Date(br.break_start) : null;
          const end   = br.break_end ? new Date(br.break_end) : null;

          const assigned   = assignShiftForUser(start, u);
          const shiftDate  = br.shiftDate  || assigned.shiftDate;
          const shiftLabel = br.shiftLabel || assigned.shiftLabel;

          let duration = typeof br.duration_minutes === "number" ? br.duration_minutes : null;
          if (duration == null && start && end) duration = Math.round((end - start) / 60000);
          if (duration == null) duration = 0;

          return {
            _id: br._id,
            kind: "AutoBreak",
            idle_start: start ? start.toISOString() : null,
            idle_end:   end ? end.toISOString() : null,
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

        // merge + sort
        const merged = [...idleSessions, ...autoBreaks].sort((a, b) => {
          const at = a.idle_start ? new Date(a.idle_start).getTime() : 0;
          const bt = b.idle_start ? new Date(b.idle_start).getTime() : 0;
          return at - bt;
        });

        const hasOngoingIdle = logs.some(l => l.status === "Idle" && l.idle_start && !l.idle_end);
        const hasOngoingAuto = abreaks.some(b => b.break_start && !b.break_end);
        const latestStatus   = deriveLatestStatus(logs);

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
      })
    );

    return res.json({ employees, settings, range: { from, to } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});



