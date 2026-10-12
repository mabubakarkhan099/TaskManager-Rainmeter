/* =========================================================================
   storage.js — persistence, validation and migration
   -------------------------------------------------------------------------
   Source of truth: window.localStorage, key "pocketTodoTodos".
   The skin loads the page through the plugin's virtual host
   (HostPath + HostOrigin=1), so this origin is a real, persistent one.

   Storage layout written by this version:
     { "version": 2, "tasks": [ { ...task }, ... ] }

   Anything else found under the key is treated as legacy data, validated,
   migrated in place and backed up first.
   ========================================================================= */

(function (global) {
  "use strict";

  var KEY = "pocketTodoTodos";
  var BACKUP_KEY = "pocketTodoTodos.backup.v1";
  var LEGACY_FILE = "todos.json";
  var VERSION = 2;

  var MAX_TASKS = 500;
  var MAX_TITLE = 200;
  var MAX_DESCRIPTION = 1000;

  var PRIORITIES = { low: true, normal: true, high: true };

  var storageAvailable = null;

  function createTaskId() {
    return (
      "t" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function storageWorks() {
    if (storageAvailable !== null) {
      return storageAvailable;
    }

    try {
      var probe = "__todo_probe__";

      global.localStorage.setItem(probe, "1");
      global.localStorage.removeItem(probe);

      storageAvailable = true;
    } catch (error) {
      storageAvailable = false;
    }

    return storageAvailable;
  }

  function readItem(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeItem(key, value) {
    try {
      global.localStorage.setItem(key, value);

      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error };
    }
  }

  /** Keeps the pre-migration payload once, without clobbering an older backup. */
  function backupRaw(raw) {
    if (readItem(BACKUP_KEY) !== null) {
      return;
    }

    writeItem(BACKUP_KEY, raw);
  }

  function normalizeText(value, maxLength) {
    if (typeof value !== "string") {
      return "";
    }

    return value.trim().slice(0, maxLength);
  }

  function normalizeTimestamp(value, fallback) {
    if (typeof value === "string" && value.trim() !== "") {
      var parsed = new Date(value);

      if (!Number.isNaN(parsed.getTime())) {
        return value;
      }
    }

    return fallback;
  }

  /**
   * Turns one stored record into a valid task, or null when it is unusable
   * (no object, no title). Missing fields get safe defaults so a partially
   * written record never breaks rendering.
   */
  function normalizeTask(record, usedIds) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return null;
    }

    var title = normalizeText(record.title, MAX_TITLE);

    if (!title) {
      return null;
    }

    var id = record.id === null || record.id === undefined ? "" : String(record.id).trim();

    if (!id || usedIds[id]) {
      id = createTaskId();
    }

    usedIds[id] = true;

    var dueDate =
      typeof record.dueDate === "string" && DateUtils.isValidDate(record.dueDate)
        ? record.dueDate.trim()
        : null;

    var dueTime =
      dueDate &&
      typeof record.dueTime === "string" &&
      DateUtils.isValidTime(record.dueTime)
        ? record.dueTime.trim()
        : null;

    var priority =
      typeof record.priority === "string" && PRIORITIES[record.priority]
        ? record.priority
        : "normal";

    var now = new Date().toISOString();
    var createdAt = normalizeTimestamp(record.createdAt, now);

    return {
      id: id,
      title: title,
      description: normalizeText(record.description, MAX_DESCRIPTION),
      dueDate: dueDate,
      dueTime: dueTime,
      priority: priority,
      completed: record.completed === true,
      createdAt: createdAt,
      updatedAt: normalizeTimestamp(record.updatedAt, createdAt),
    };
  }

  function normalizeList(list) {
    var usedIds = Object.create(null);
    var tasks = [];

    for (var index = 0; index < list.length && tasks.length < MAX_TASKS; index += 1) {
      var task = normalizeTask(list[index], usedIds);

      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * Reads the stored payload.
   * @returns {{tasks: Array, migrated: boolean, unreadable: boolean}|null}
   *   null when nothing is stored at all.
   */
  function parseStored(raw) {
    var value;

    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { tasks: [], migrated: false, unreadable: true };
    }

    if (Array.isArray(value)) {
      return { tasks: normalizeList(value), migrated: true, unreadable: false };
    }

    if (value && typeof value === "object" && Array.isArray(value.tasks)) {
      return {
        tasks: normalizeList(value.tasks),
        migrated: value.version !== VERSION,
        unreadable: false,
      };
    }

    return { tasks: [], migrated: false, unreadable: true };
  }

  /**
   * One-time import of the legacy tasks file that ships next to index.html.
   * Only runs when localStorage holds nothing at all, so it never resurrects
   * tasks the user has deliberately emptied.
   */
  function importLegacyFile() {
    if (typeof global.fetch !== "function") {
      return Promise.resolve([]);
    }

    return global
      .fetch(LEGACY_FILE, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }

        return response.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) {
          return [];
        }

        return normalizeList(data);
      })
      .catch(function (error) {
        console.warn("Todo widget: could not read " + LEGACY_FILE, error);

        return [];
      });
  }

  function serialize(tasks) {
    return JSON.stringify({ version: VERSION, tasks: tasks });
  }

  /**
   * Loads every task.
   * @returns {Promise<{tasks: Array, notices: string[], storageAvailable: boolean}>}
   */
  function load() {
    var notices = [];

    if (!storageWorks()) {
      notices.push("storage-unavailable");

      return Promise.resolve({
        tasks: [],
        notices: notices,
        storageAvailable: false,
      });
    }

    var raw = readItem(KEY);

    if (raw !== null) {
      var stored = parseStored(raw);

      if (stored.unreadable) {
        backupRaw(raw);
        notices.push("recovered");
      } else if (stored.migrated) {
        backupRaw(raw);
        notices.push("migrated");
      }

      var tasks = stored.tasks;

      if (stored.migrated || stored.unreadable) {
        writeItem(KEY, serialize(tasks));
      }

      return Promise.resolve({
        tasks: tasks,
        notices: notices,
        storageAvailable: true,
      });
    }

    return importLegacyFile().then(function (imported) {
      if (imported.length > 0) {
        notices.push("imported");
        writeItem(KEY, serialize(imported));
      }

      return {
        tasks: imported,
        notices: notices,
        storageAvailable: true,
      };
    });
  }

  /** @returns {{ok: boolean, error: Error|null}} */
  function save(tasks) {
    if (!storageWorks()) {
      return { ok: false, error: new Error("localStorage is unavailable") };
    }

    return writeItem(KEY, serialize(tasks));
  }

  global.TaskStorage = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    LEGACY_FILE: LEGACY_FILE,
    VERSION: VERSION,
    MAX_TITLE: MAX_TITLE,
    MAX_DESCRIPTION: MAX_DESCRIPTION,
    createTaskId: createTaskId,
    normalizeTask: normalizeTask,
    normalizeList: normalizeList,
    load: load,
    save: save,
    isAvailable: storageWorks,
  };
})(window);
