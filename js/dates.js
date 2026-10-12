/* =========================================================================
   dates.js — date & time helpers
   -------------------------------------------------------------------------
   All stored values are plain local strings ("YYYY-MM-DD", "HH:MM").
   Nothing here goes through Date("2026-09-24"), which is parsed as UTC and
   can shift a due date to the previous day in negative-offset time zones.
   ========================================================================= */

(function (global) {
  "use strict";

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var TIME_RE = /^(\d{1,2}):(\d{2})$/;
  var MS_PER_DAY = 86400000;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function isRealDate(year, month, day) {
    var probe = new Date(year, month - 1, day, 0, 0, 0, 0);

    return (
      probe.getFullYear() === year &&
      probe.getMonth() === month - 1 &&
      probe.getDate() === day
    );
  }

  /** "YYYY-MM-DD" -> { year, month, day } or null when missing/invalid. */
  function parseDate(dateString) {
    if (typeof dateString !== "string") {
      return null;
    }

    var match = DATE_RE.exec(dateString.trim());

    if (!match) {
      return null;
    }

    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    if (!isRealDate(year, month, day)) {
      return null;
    }

    return { year: year, month: month, day: day };
  }

  /** "HH:MM" -> { hour, minute } or null when missing/invalid. */
  function parseTime(timeString) {
    if (typeof timeString !== "string") {
      return null;
    }

    var match = TIME_RE.exec(timeString.trim());

    if (!match) {
      return null;
    }

    var hour = Number(match[1]);
    var minute = Number(match[2]);

    if (hour > 23 || minute > 59) {
      return null;
    }

    return { hour: hour, minute: minute };
  }

  function isValidDate(dateString) {
    return parseDate(dateString) !== null;
  }

  function isValidTime(timeString) {
    return parseTime(timeString) !== null;
  }

  /**
   * Builds a local Date from stored parts.
   * A date without a time is either the start of that day (sorting) or the
   * end of it (overdue checks), so a task due "today" is not overdue yet.
   */
  function toLocalDate(dateString, timeString, endOfDayWhenNoTime) {
    var parts = parseDate(dateString);

    if (!parts) {
      return null;
    }

    var time = parseTime(timeString);

    if (!time) {
      return endOfDayWhenNoTime
        ? new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999)
        : new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
    }

    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      time.hour,
      time.minute,
      0,
      0
    );
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  /** Whole days between two local dates (DST-safe because it rounds). */
  function dayOffset(target, reference) {
    var difference = startOfDay(target).getTime() - startOfDay(reference).getTime();

    return Math.round(difference / MS_PER_DAY);
  }

  function formatClock(timeString) {
    var time = parseTime(timeString);

    if (!time) {
      return "";
    }

    var date = new Date(2000, 0, 1, time.hour, time.minute, 0, 0);

    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatShortDate(date, reference) {
    var sameYear = date.getFullYear() === reference.getFullYear();

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
  }

  /**
   * Describes a task's schedule for display.
   *
   * @returns {{
   *   hasDue: boolean, label: string, dayLabel: string, timeLabel: string,
   *   state: "none"|"overdue"|"today"|"tomorrow"|"scheduled"|"past",
   *   overdue: boolean, isToday: boolean, dueTime: number|null
   * }}
   */
  function describeDue(dateString, timeString, completed, now) {
    var reference = now || new Date();
    var due = toLocalDate(dateString, timeString, !parseTime(timeString));

    if (!due) {
      return {
        hasDue: false,
        label: "No due date",
        dayLabel: "",
        timeLabel: "",
        state: "none",
        overdue: false,
        isToday: false,
        dueTime: null,
      };
    }

    var offset = dayOffset(due, reference);
    var overdue = !completed && due.getTime() < reference.getTime();
    var dayLabel;

    if (offset === 0) {
      dayLabel = "Today";
    } else if (offset === 1) {
      dayLabel = "Tomorrow";
    } else if (offset === -1) {
      dayLabel = "Yesterday";
    } else {
      dayLabel = formatShortDate(due, reference);
    }

    var timeLabel = formatClock(timeString);

    return {
      hasDue: true,
      label: timeLabel ? dayLabel + " · " + timeLabel : dayLabel,
      dayLabel: dayLabel,
      timeLabel: timeLabel,
      state: overdue ? "overdue" : offset <= 0 ? "past" : dayLabel === "Today" ? "today" : "scheduled",
      overdue: overdue,
      isToday: offset === 0,
      dueTime: due.getTime(),
    };
  }

  /** Sort key: a date with a time sorts inside its day, a date-only task first. */
  function dueSortValue(dateString, timeString) {
    var due = toLocalDate(dateString, timeString, false);

    return due ? due.getTime() : null;
  }

  function todayISO() {
    var now = new Date();

    return (
      now.getFullYear() +
      "-" +
      pad(now.getMonth() + 1) +
      "-" +
      pad(now.getDate())
    );
  }

  /** Signature used to detect a minute/day change without re-rendering blindly. */
  function daySignature(now) {
    var reference = now || new Date();

    return (
      reference.getFullYear() +
      "-" +
      pad(reference.getMonth() + 1) +
      "-" +
      pad(reference.getDate())
    );
  }

  global.DateUtils = {
    parseDate: parseDate,
    parseTime: parseTime,
    isValidDate: isValidDate,
    isValidTime: isValidTime,
    toLocalDate: toLocalDate,
    startOfDay: startOfDay,
    dayOffset: dayOffset,
    formatClock: formatClock,
    describeDue: describeDue,
    dueSortValue: dueSortValue,
    todayISO: todayISO,
    daySignature: daySignature,
  };
})(window);
