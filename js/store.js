/* =========================================================================
   store.js — task model
   -------------------------------------------------------------------------
   Holds the in-memory task list and every rule about creating, changing,
   ordering and selecting tasks. Rendering and persistence stay elsewhere;
   the app layer decides when to save and re-render.
   ========================================================================= */

(function (global) {
  "use strict";

  var PRIORITIES = { low: true, normal: true, high: true };
  var COPY_SUFFIX = " (copy)";

  var tasks = [];

  function nowISO() {
    return new Date().toISOString();
  }

  function isValidPriority(value) {
    return typeof value === "string" && PRIORITIES[value];
  }

  function normalizeFields(fields) {
    var source = fields || {};
    var dueDate = DateUtils.isValidDate(source.dueDate) ? source.dueDate : null;

    return {
      title: typeof source.title === "string" ? source.title.trim() : "",
      description:
        typeof source.description === "string" ? source.description.trim() : "",
      dueDate: dueDate,
      // A time on its own is meaningless, so it is dropped with the date.
      dueTime: dueDate && DateUtils.isValidTime(source.dueTime) ? source.dueTime : null,
      priority: isValidPriority(source.priority) ? source.priority : "normal",
    };
  }

  /* ----------------------------- Reading ---------------------------- */

  function all() {
    return tasks;
  }

  function get(id) {
    for (var index = 0; index < tasks.length; index += 1) {
      if (tasks[index].id === id) {
        return tasks[index];
      }
    }

    return null;
  }

  function isOverdue(task, now) {
    if (!task || task.completed || !task.dueDate) {
      return false;
    }

    return DateUtils.describeDue(task.dueDate, task.dueTime, task.completed, now)
      .overdue;
  }

  /** Same order for both groups: soonest due date first, unscheduled last. */
  function compareTasks(first, second) {
    var firstDue = DateUtils.dueSortValue(first.dueDate, first.dueTime);
    var secondDue = DateUtils.dueSortValue(second.dueDate, second.dueTime);

    if (firstDue !== null && secondDue !== null) {
      if (firstDue !== secondDue) {
        return firstDue - secondDue;
      }
    } else if (firstDue !== null) {
      return -1;
    } else if (secondDue !== null) {
      return 1;
    }

    if (first.createdAt !== second.createdAt) {
      return first.createdAt < second.createdAt ? -1 : 1;
    }

    if (first.id === second.id) {
      return 0;
    }

    return first.id < second.id ? -1 : 1;
  }

  function matchesQuery(task, query) {
    if (!query) {
      return true;
    }

    var needle = query.toLowerCase();

    return (
      task.title.toLowerCase().indexOf(needle) !== -1 ||
      task.description.toLowerCase().indexOf(needle) !== -1
    );
  }

  /**
   * The tasks the current view should show, already ordered.
   * @returns {{active: Array, completed: Array}}
   */
  function visible(filter, query, now) {
    var reference = now || new Date();
    var matched = tasks.filter(function (task) {
      return matchesQuery(task, query);
    });

    var active = [];
    var completed = [];

    matched.forEach(function (task) {
      if (task.completed) {
        completed.push(task);
      } else {
        active.push(task);
      }
    });

    active.sort(compareTasks);
    completed.sort(compareTasks);

    if (filter === "active") {
      completed = [];
    } else if (filter === "completed") {
      active = [];
    } else if (filter === "overdue") {
      completed = [];
      active = active.filter(function (task) {
        return isOverdue(task, reference);
      });
    }

    return { active: active, completed: completed };
  }

  function counts(now) {
    var reference = now || new Date();
    var result = { total: tasks.length, active: 0, completed: 0, overdue: 0 };

    tasks.forEach(function (task) {
      if (task.completed) {
        result.completed += 1;
      } else {
        result.active += 1;

        if (isOverdue(task, reference)) {
          result.overdue += 1;
        }
      }
    });

    return result;
  }

  /**
   * Signature of everything that can change with the clock alone: the current
   * day (friendly labels) and which tasks are overdue.
   */
  function timeSignature(now) {
    var reference = now || new Date();
    var overdueIds = [];

    tasks.forEach(function (task) {
      if (isOverdue(task, reference)) {
        overdueIds.push(task.id);
      }
    });

    overdueIds.sort();

    return DateUtils.daySignature(reference) + "|" + overdueIds.join(",");
  }

  /* ---------------------------- Mutations --------------------------- */

  function replaceAll(list) {
    tasks = Array.isArray(list) ? list.slice() : [];
  }

  function create(fields) {
    var values = normalizeFields(fields);
    var timestamp = nowISO();

    var task = {
      id: TaskStorage.createTaskId(),
      title: values.title,
      description: values.description,
      dueDate: values.dueDate,
      dueTime: values.dueTime,
      priority: values.priority,
      completed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    tasks.push(task);

    return task;
  }

  function update(id, fields) {
    var task = get(id);

    if (!task) {
      return null;
    }

    var values = normalizeFields(fields);

    task.title = values.title;
    task.description = values.description;
    task.dueDate = values.dueDate;
    task.dueTime = values.dueTime;
    task.priority = values.priority;
    task.updatedAt = nowISO();

    return task;
  }

  function setCompleted(id, completed) {
    var task = get(id);

    if (!task) {
      return null;
    }

    task.completed = completed === true;
    task.updatedAt = nowISO();

    return task;
  }

  function toggle(id) {
    var task = get(id);

    if (!task) {
      return null;
    }

    return setCompleted(id, !task.completed);
  }

  /** @returns {{task: Object, index: number}|null} */
  function remove(id) {
    for (var index = 0; index < tasks.length; index += 1) {
      if (tasks[index].id === id) {
        return { task: tasks.splice(index, 1)[0], index: index };
      }
    }

    return null;
  }

  function insert(task, index) {
    if (!task || typeof index !== "number" || index < 0 || index > tasks.length) {
      tasks.push(task);

      return task;
    }

    tasks.splice(index, 0, task);

    return task;
  }

  function duplicate(id) {
    var task = get(id);

    if (!task) {
      return null;
    }

    var title = task.title;

    if (title.slice(-COPY_SUFFIX.length).toLowerCase() !== COPY_SUFFIX) {
      title = title.slice(0, TaskStorage.MAX_TITLE - COPY_SUFFIX.length) + COPY_SUFFIX;
    }

    var timestamp = nowISO();

    var copy = {
      id: TaskStorage.createTaskId(),
      title: title,
      description: task.description,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      priority: task.priority,
      completed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    tasks.push(copy);

    return copy;
  }

  global.TaskStore = {
    all: all,
    get: get,
    create: create,
    update: update,
    setCompleted: setCompleted,
    toggle: toggle,
    remove: remove,
    insert: insert,
    duplicate: duplicate,
    replaceAll: replaceAll,
    visible: visible,
    counts: counts,
    isOverdue: isOverdue,
    timeSignature: timeSignature,
  };
})(window);
