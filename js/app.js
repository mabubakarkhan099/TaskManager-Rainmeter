/* =========================================================================
   app.js — rendering, interaction and the Rainmeter bridge
   -------------------------------------------------------------------------
   Single entry point. Listeners are registered exactly once here (event
   delegation on the task area), so repeated renders can never double up
   handlers. User text always reaches the DOM through textContent.

   Task ordering lives in store.js; this file only decides how the ordered
   list is grouped and phrased: open tasks by when they are due, finished
   tasks in one group at the end.
   ========================================================================= */

(function (global) {
  "use strict";

  /* The board's groups, in the order a day reads. */
  var BUCKETS = [
    { key: "late", label: "Late" },
    { key: "today", label: "Today" },
    { key: "tomorrow", label: "Tomorrow" },
    { key: "later", label: "Later" },
    { key: "none", label: "No date" },
  ];

  var META_MESSAGES = {
    "storage-unavailable":
      "Changes can't be saved in this environment. Tasks are kept until the widget restarts.",
    recovered:
      "Saved tasks were unreadable, so the list started empty. The previous copy was kept under the backup key.",
    migrated: "Existing tasks were upgraded to the new format.",
    imported: "Existing tasks were imported from todos.json.",
  };

  var EMPTY_MESSAGES = {
    active: "Nothing open. Everything here is finished.",
    completed: "Nothing finished yet.",
    overdue: "Nothing is late.",
  };

  var state = {
    filter: "all",
    query: "",
    editingId: null,
    pendingDeleteId: null,
    highlightId: null,
    lastFocus: null,
    lastSubmit: 0,
    signature: "",
    storageWarned: false,
  };

  var dom = {};
  var rowTemplate = null;
  var bucketTemplate = null;
  var overdueTimer = null;

  /* =======================================================================
     ELEMENTS
     ======================================================================= */

  function cacheElements() {
    dom.widget = document.getElementById("widget");
    dom.widgetBody = document.getElementById("widgetBody");

    dom.mastheadDate = document.getElementById("mastheadDate");
    dom.statusLine = document.getElementById("statusLine");
    dom.filters = document.getElementById("filters");
    dom.searchToggle = document.getElementById("searchToggle");
    dom.searchRow = document.getElementById("searchRow");
    dom.searchInput = document.getElementById("searchInput");
    dom.searchClear = document.getElementById("searchClear");
    dom.reloadBtn = document.getElementById("reloadBtn");

    dom.taskArea = document.getElementById("taskArea");
    dom.taskList = document.getElementById("taskList");
    dom.emptyState = document.getElementById("emptyState");

    dom.addTaskBtn = document.getElementById("addTaskBtn");

    dom.taskOverlay = document.getElementById("taskOverlay");
    dom.taskForm = document.getElementById("taskForm");
    dom.taskFormTitle = document.getElementById("taskFormTitle");
    dom.formClose = document.getElementById("formClose");
    dom.formCancel = document.getElementById("formCancel");
    dom.formSubmit = document.getElementById("formSubmit");
    dom.titleInput = document.getElementById("taskTitleInput");
    dom.dateInput = document.getElementById("taskDateInput");
    dom.timeInput = document.getElementById("taskTimeInput");
    dom.descriptionInput = document.getElementById("taskDescriptionInput");
    dom.clearSchedule = document.getElementById("clearSchedule");
    dom.titleError = document.getElementById("titleError");

    dom.confirmOverlay = document.getElementById("confirmOverlay");
    dom.confirmMessage = document.getElementById("confirmMessage");
    dom.confirmCancel = document.getElementById("confirmCancel");
    dom.confirmDelete = document.getElementById("confirmDelete");

    dom.toastRegion = document.getElementById("toastRegion");

    rowTemplate = document.getElementById("taskTemplate");
    bucketTemplate = document.getElementById("bucketTemplate");
  }

  /* =======================================================================
     TOASTS
     ======================================================================= */

  function showToast(message, options) {
    var settings = options || {};

    while (dom.toastRegion.children.length >= 2) {
      dom.toastRegion.removeChild(dom.toastRegion.firstElementChild);
    }

    var toast = document.createElement("div");
    toast.className = "toast";

    var text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = message;

    toast.appendChild(text);

    var timeout = null;

    function dismiss() {
      if (timeout !== null) {
        global.clearTimeout(timeout);
        timeout = null;
      }

      toast.classList.add("is-leaving");

      global.setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 170);
    }

    if (settings.actionLabel && typeof settings.onAction === "function") {
      var action = document.createElement("button");
      action.type = "button";
      action.className = "toast-action";
      action.textContent = settings.actionLabel;

      action.addEventListener("click", function () {
        dismiss();
        settings.onAction();
      });

      toast.appendChild(action);
    }

    dom.toastRegion.appendChild(toast);

    timeout = global.setTimeout(dismiss, settings.duration || 2000);

    return dismiss;
  }

  /* =======================================================================
     OVERLAYS
     ======================================================================= */

  function anyOverlayOpen() {
    return !dom.taskOverlay.hidden || !dom.confirmOverlay.hidden;
  }

  function setBodyInert(inert) {
    if ("inert" in dom.widgetBody) {
      dom.widgetBody.inert = inert;
    }
  }

  function openOverlay(element) {
    element.hidden = false;
    setBodyInert(true);
  }

  function closeOverlay(element) {
    element.hidden = true;

    if (!anyOverlayOpen()) {
      setBodyInert(false);
    }
  }

  function restoreFocus() {
    var previous = state.lastFocus;
    state.lastFocus = null;

    if (previous && previous.isConnected && typeof previous.focus === "function") {
      previous.focus();

      return;
    }

    dom.addTaskBtn.focus();
  }

  /* =======================================================================
     DATES — reading a task's place in the day
     ======================================================================= */

  /** Whole days from today to the task's due date, or null when undated. */
  function dayOffset(dateString, now) {
    var parts = DateUtils.parseDate(dateString);

    if (!parts) {
      return null;
    }

    return DateUtils.dayOffset(new Date(parts.year, parts.month - 1, parts.day), now);
  }

  function bucketKey(task, now) {
    if (!task.dueDate) {
      return "none";
    }

    if (TaskStore.isOverdue(task, now)) {
      return "late";
    }

    var offset = dayOffset(task.dueDate, now);

    if (offset === null || offset < 0) {
      return "late";
    }

    if (offset === 0) {
      return "today";
    }

    if (offset === 1) {
      return "tomorrow";
    }

    return "later";
  }

  /**
   * What the row has to say about its own schedule. The group already states
   * the day, so a row inside Today or Tomorrow only repeats its clock time.
   */
  function whenLabel(bucket, due) {
    var day = due.dayLabel;
    var time = due.timeLabel;

    if (bucket === "today" || bucket === "tomorrow") {
      return time || "";
    }

    if (!time) {
      return day;
    }

    return day + ", " + time;
  }

  /** The next thing that will actually fall due, phrased for the status line. */
  function nextDeadline(now) {
    var active = TaskStore.visible("active", "", now).active;

    for (var index = 0; index < active.length; index += 1) {
      var task = active[index];

      if (!task.dueDate) {
        continue;
      }

      var due = DateUtils.describeDue(task.dueDate, task.dueTime, false, now);

      if (due.overdue) {
        continue;
      }

      if (due.isToday) {
        // A task due today without a time says nothing the Today group
        // doesn't already say, so keep looking for a clock time.
        if (due.timeLabel) {
          return "due at " + due.timeLabel;
        }

        continue;
      }

      if (due.dayLabel === "Tomorrow") {
        return "due tomorrow" + (due.timeLabel ? " at " + due.timeLabel : "");
      }

      return "due " + due.dayLabel + (due.timeLabel ? " at " + due.timeLabel : "");
    }

    return null;
  }

  /* =======================================================================
     RENDER — ROWS AND GROUPS
     ======================================================================= */

  function buildRow(task, now, bucket) {
    var fragment = rowTemplate.content.cloneNode(true);

    var item = fragment.querySelector(".task-item");
    var toggle = fragment.querySelector(".task-toggle");
    var title = fragment.querySelector(".task-title");
    var flag = fragment.querySelector(".task-flag");
    var when = fragment.querySelector(".task-when");
    var description = fragment.querySelector(".task-desc");

    var due = DateUtils.describeDue(task.dueDate, task.dueTime, task.completed, now);

    item.dataset.id = task.id;
    item.classList.toggle("is-completed", task.completed);
    item.classList.toggle("is-high", task.priority === "high");
    item.classList.toggle("is-low", task.priority === "low");

    if (state.highlightId === task.id) {
      item.classList.add("is-new");
    }

    toggle.checked = task.completed;
    toggle.setAttribute(
      "aria-label",
      (task.completed ? "Reopen " : "Complete ") + task.title
    );

    title.textContent = task.title;
    title.title = task.title;

    if (task.priority === "high" && !task.completed) {
      flag.textContent = "High";
      flag.hidden = false;
    } else {
      flag.hidden = true;
    }

    if (due.hasDue) {
      when.textContent = whenLabel(bucket, due);
      when.hidden = !when.textContent;

      if (!task.completed) {
        when.classList.toggle("is-late", bucket === "late" || due.overdue);
        when.classList.toggle("is-today", bucket === "today");
      }

      when.title = "Due " + due.dayLabel + (due.timeLabel ? ", " + due.timeLabel : "");
    } else {
      when.hidden = true;
    }

    if (task.description) {
      description.textContent = task.description;
      description.title = task.description;
      description.hidden = false;
    } else {
      description.textContent = "";
      description.hidden = true;
    }

    var editBtn = fragment.querySelector(".act-edit");
    var duplicateBtn = fragment.querySelector(".act-duplicate");
    var deleteBtn = fragment.querySelector(".act-delete");

    editBtn.setAttribute("aria-label", "Edit " + task.title);
    editBtn.title = "Edit";
    duplicateBtn.setAttribute("aria-label", "Duplicate " + task.title);
    duplicateBtn.title = "Duplicate";
    deleteBtn.setAttribute("aria-label", "Delete " + task.title);
    deleteBtn.title = "Delete";

    return item;
  }

  function buildBucket(key, label, tasks, now) {
    var fragment = bucketTemplate.content.cloneNode(true);

    var bucket = fragment.querySelector(".bucket");
    var heading = fragment.querySelector(".bucket-heading");
    var labelCell = fragment.querySelector(".bucket-label");
    var countCell = fragment.querySelector(".bucket-count");
    var list = fragment.querySelector(".task-list");

    var id = "bucket-" + key;

    bucket.classList.add("is-" + key);
    heading.id = id;
    labelCell.textContent = label;
    countCell.textContent = String(tasks.length);
    list.setAttribute("aria-labelledby", id);

    tasks.forEach(function (task) {
      list.appendChild(buildRow(task, now, key));
    });

    return fragment;
  }

  function renderBoard() {
    var now = new Date();
    var view = TaskStore.visible(state.filter, state.query, now);
    var groups = {};
    var fragment = document.createDocumentFragment();
    var shown = 0;

    BUCKETS.forEach(function (bucket) {
      groups[bucket.key] = [];
    });

    view.active.forEach(function (task) {
      groups[bucketKey(task, now)].push(task);
    });

    BUCKETS.forEach(function (bucket) {
      if (groups[bucket.key].length === 0) {
        return;
      }

      fragment.appendChild(buildBucket(bucket.key, bucket.label, groups[bucket.key], now));
      shown += groups[bucket.key].length;
    });

    if (view.completed.length > 0) {
      fragment.appendChild(buildBucket("done", "Done", view.completed, now));
      shown += view.completed.length;
    }

    dom.taskList.replaceChildren(fragment);

    if (shown === 0) {
      dom.emptyState.textContent = emptyMessage();
    }

    dom.emptyState.hidden = shown > 0;
    state.highlightId = null;
  }

  function emptyMessage() {
    if (TaskStore.all().length === 0) {
      return "Nothing here yet. Add your first task below.";
    }

    if (state.query) {
      return "Nothing matches “" + state.query + "”.";
    }

    return EMPTY_MESSAGES[state.filter] || "Nothing to show here.";
  }

  function renderMasthead() {
    dom.mastheadDate.textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  function renderStatus() {
    var now = new Date();
    var counts = TaskStore.counts(now);
    var segments = [];

    if (counts.total === 0) {
      segments.push({ text: "No tasks yet" });
    } else if (counts.active === 0) {
      segments.push({ text: "Everything done" });
    } else {
      segments.push({ text: counts.active + " open" });
    }

    if (counts.overdue > 0) {
      segments.push({ text: counts.overdue + " late", tone: "is-alarm" });
    }

    var next = nextDeadline(now);

    if (next) {
      segments.push({ text: "next " + next });
    }

    var fragment = document.createDocumentFragment();

    segments.forEach(function (segment, index) {
      if (index > 0) {
        var separator = document.createElement("span");
        separator.className = "status-sep";
        separator.setAttribute("aria-hidden", "true");

        fragment.appendChild(separator);
      }

      var cell = document.createElement("span");
      cell.textContent = segment.text;

      if (segment.tone) {
        cell.className = segment.tone;
      }

      fragment.appendChild(cell);
    });

    dom.statusLine.replaceChildren(fragment);
  }

  function renderFilters() {
    var counts = TaskStore.counts(new Date());

    var badges = dom.filters.querySelectorAll("[data-count-for]");

    Array.prototype.forEach.call(badges, function (badge) {
      // The "All" tab counts every task; the others match their own key.
      var key = badge.dataset.countFor === "all" ? "total" : badge.dataset.countFor;
      var value = counts[key] || 0;

      badge.textContent = String(value);
      badge.classList.toggle("is-zero", value === 0);
    });

    var buttons = dom.filters.querySelectorAll(".filter-btn");

    Array.prototype.forEach.call(buttons, function (button) {
      var active = button.dataset.filter === state.filter;

      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function render() {
    renderMasthead();
    renderStatus();
    renderFilters();
    renderBoard();

    state.signature = TaskStore.timeSignature(new Date());
  }

  /* =======================================================================
     PERSISTENCE HELPERS
     ======================================================================= */

  function persist() {
    var result = TaskStorage.save(TaskStore.all());

    if (!result.ok) {
      console.warn("Todo widget: saving failed", result.error);

      if (!state.storageWarned) {
        state.storageWarned = true;
        showToast(META_MESSAGES["storage-unavailable"], { duration: 9000 });
      }
    }
  }

  function commit() {
    persist();
    render();
  }

  /* =======================================================================
     TASK OPERATIONS
     ======================================================================= */

  function toggleTask(id) {
    if (!TaskStore.toggle(id)) {
      return;
    }

    // The row, its group and the counters all change, so re-render.
    commit();
  }

  function duplicateTask(id) {
    var copy = TaskStore.duplicate(id);

    if (!copy) {
      return;
    }

    state.highlightId = copy.id;
    commit();
    showToast("Task duplicated");
  }

  function requestDelete(id) {
    var task = TaskStore.get(id);

    if (!task) {
      return;
    }

    state.pendingDeleteId = id;
    state.lastFocus = document.activeElement;

    dom.confirmMessage.textContent =
      "“" + task.title + "” will be removed from your list. You can undo right after.";

    openOverlay(dom.confirmOverlay);
    dom.confirmDelete.focus();
  }

  function cancelDelete() {
    state.pendingDeleteId = null;

    closeOverlay(dom.confirmOverlay);
    restoreFocus();
  }

  function confirmDelete() {
    var id = state.pendingDeleteId;

    state.pendingDeleteId = null;
    closeOverlay(dom.confirmOverlay);

    if (!id) {
      return;
    }

    var removed = TaskStore.remove(id);

    commit();

    if (!removed) {
      return;
    }

    showToast("Task deleted", {
      actionLabel: "Undo",
      duration: 6500,
      onAction: function () {
        TaskStore.insert(removed.task, removed.index);
        state.highlightId = removed.task.id;
        commit();
        showToast("Task restored");
      },
    });

    restoreFocus();
  }

  /* =======================================================================
     EDITOR
     ======================================================================= */

  function selectedPriority() {
    var checked = dom.taskForm.querySelector('input[name="priority"]:checked');

    return checked ? checked.value : "normal";
  }

  function setPriority(priority) {
    var value = priority === "low" || priority === "high" ? priority : "normal";
    var input = dom.taskForm.querySelector('input[name="priority"][value="' + value + '"]');

    if (input) {
      input.checked = true;
    }
  }

  function clearTitleError() {
    dom.titleError.hidden = true;
    dom.titleError.textContent = "";
    dom.titleInput.removeAttribute("aria-invalid");
    dom.titleInput.removeAttribute("aria-describedby");
  }

  function showTitleError(message) {
    dom.titleError.textContent = message;
    dom.titleError.hidden = false;
    dom.titleInput.setAttribute("aria-invalid", "true");
    dom.titleInput.setAttribute("aria-describedby", "titleError");
    dom.titleInput.focus();
  }

  function openEditor(task) {
    state.editingId = task ? task.id : null;
    state.lastFocus = document.activeElement;

    dom.taskFormTitle.textContent = task ? "Edit task" : "Add task";
    dom.formSubmit.textContent = task ? "Save changes" : "Save task";

    dom.titleInput.value = task ? task.title : "";
    dom.dateInput.value = task ? task.dueDate || "" : "";
    dom.timeInput.value = task ? task.dueTime || "" : "";
    dom.descriptionInput.value = task ? task.description : "";

    setPriority(task ? task.priority : "normal");
    clearTitleError();

    openOverlay(dom.taskOverlay);

    dom.titleInput.focus();

    if (dom.titleInput.setSelectionRange) {
      var end = dom.titleInput.value.length;

      dom.titleInput.setSelectionRange(end, end);
    }
  }

  function closeEditor(options) {
    state.editingId = null;

    closeOverlay(dom.taskOverlay);
    dom.taskForm.reset();
    setPriority("normal");
    clearTitleError();

    if (!options || options.restoreFocus !== false) {
      restoreFocus();
    }
  }

  function submitEditor() {
    var stamp = Date.now();

    // Guards against a double click or a held Enter key saving twice.
    if (stamp - state.lastSubmit < 400) {
      return;
    }

    state.lastSubmit = stamp;

    var title = dom.titleInput.value.trim();

    if (!title) {
      showTitleError("Add a title before saving this task.");

      return;
    }

    var dueDate = dom.dateInput.value || null;

    var fields = {
      title: title,
      description: dom.descriptionInput.value.trim(),
      dueDate: dueDate,
      // A time without a date would be meaningless, so it is dropped.
      dueTime: dueDate ? dom.timeInput.value || null : null,
      priority: selectedPriority(),
    };

    if (state.editingId) {
      TaskStore.update(state.editingId, fields);
      commit();
      showToast("Task updated");
    } else {
      var created = TaskStore.create(fields);

      state.highlightId = created.id;
      commit();
      showToast("Task added");
    }

    closeEditor();
  }

  /* =======================================================================
     SEARCH
     ======================================================================= */

  function openSearch() {
    dom.searchRow.hidden = false;
    dom.searchToggle.setAttribute("aria-expanded", "true");
    dom.searchInput.focus();

    if (dom.searchInput.value) {
      dom.searchInput.select();
    }
  }

  function closeSearch(clear) {
    dom.searchRow.hidden = true;
    dom.searchToggle.setAttribute("aria-expanded", "false");

    if (clear) {
      dom.searchInput.value = "";
      state.query = "";
      render();
    }
  }

  /* =======================================================================
     RAINMETER BRIDGE
     -----------------------------------------------------------------------
     The WebView2 plugin exposes RainmeterAPI on the page. Bang() returns a
     promise, so rejections are swallowed instead of surfacing as console
     errors when the page is opened outside Rainmeter.
     ======================================================================= */

  function rainmeterBang(command) {
    var api = global.RainmeterAPI;

    if (!api || typeof api.Bang !== "function") {
      return false;
    }

    try {
      var result = api.Bang(command);

      if (result && typeof result.catch === "function") {
        result.catch(function (error) {
          console.warn("Todo widget: Rainmeter bang failed", error);
        });
      }

      return true;
    } catch (error) {
      console.warn("Todo widget: Rainmeter bang failed", error);

      return false;
    }
  }

  /* =======================================================================
     RELOAD & TIME WATCHER
     ======================================================================= */

  function reloadFromStorage() {
    if (!TaskStorage.isAvailable()) {
      showToast("Storage is unavailable, so there is nothing to reload.", {
        duration: 5000,
      });

      return;
    }

    TaskStorage.load()
      .then(function (result) {
        TaskStore.replaceAll(result.tasks);
        render();
        reportNotices(result.notices);
        showToast("Tasks reloaded");
      })
      .catch(function (error) {
        console.error("Todo widget: reload failed", error);
        showToast("Tasks couldn't be reloaded.");
      });
  }

  /**
   * One managed timer for the whole session. It only re-renders when the day
   * rolls over or a task becomes overdue, so idle cost is a single date read.
   */
  function checkTimeSensitiveState() {
    var signature = TaskStore.timeSignature(new Date());

    if (signature === state.signature) {
      return;
    }

    render();
  }

  function startTimeWatcher() {
    if (overdueTimer !== null) {
      return;
    }

    overdueTimer = global.setInterval(checkTimeSensitiveState, 60000);
  }

  /* =======================================================================
     EVENTS
     ======================================================================= */

  function isTextEntry(element) {
    if (!element) {
      return false;
    }

    var tag = element.tagName;

    return (
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable
    );
  }

  function bindEvents() {
    dom.addTaskBtn.addEventListener("click", function () {
      openEditor(null);
    });

    dom.taskForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitEditor();
    });

    dom.formClose.addEventListener("click", function () {
      closeEditor();
    });

    dom.formCancel.addEventListener("click", function () {
      closeEditor();
    });

    dom.clearSchedule.addEventListener("click", function () {
      dom.dateInput.value = "";
      dom.timeInput.value = "";
      dom.dateInput.focus();
    });

    dom.titleInput.addEventListener("input", clearTitleError);

    dom.confirmCancel.addEventListener("click", cancelDelete);
    dom.confirmDelete.addEventListener("click", confirmDelete);

    dom.taskOverlay.addEventListener("click", function (event) {
      if (event.target === dom.taskOverlay) {
        closeEditor();
      }
    });

    dom.confirmOverlay.addEventListener("click", function (event) {
      if (event.target === dom.confirmOverlay) {
        cancelDelete();
      }
    });

    /* ------------------------------ filters ---------------------------- */

    dom.filters.addEventListener("click", function (event) {
      var button = event.target.closest(".filter-btn");

      if (!button) {
        return;
      }

      state.filter = button.dataset.filter;
      render();
    });

    /* ------------------------------ search ----------------------------- */

    dom.searchToggle.addEventListener("click", function () {
      if (dom.searchRow.hidden) {
        openSearch();
      } else {
        closeSearch(true);
      }
    });

    dom.searchInput.addEventListener("input", function () {
      state.query = dom.searchInput.value.trim();

      renderBoard();
    });

    dom.searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSearch(true);
        dom.searchToggle.focus();
      }
    });

    dom.searchClear.addEventListener("click", function () {
      dom.searchInput.value = "";
      state.query = "";
      render();
      dom.searchInput.focus();
    });

    /* ------------------------------ reload ----------------------------- */

    dom.reloadBtn.addEventListener("click", reloadFromStorage);

    // Double-click keeps the original full skin refresh available.
    dom.reloadBtn.addEventListener("dblclick", function () {
      if (!rainmeterBang("!Refresh")) {
        global.location.reload();
      }
    });

    /* --------------------------- task actions -------------------------- */

    dom.taskArea.addEventListener("change", function (event) {
      var toggle = event.target.closest(".task-toggle");

      if (!toggle) {
        return;
      }

      var item = toggle.closest(".task-item");

      if (item) {
        toggleTask(item.dataset.id);
      }
    });

    dom.taskArea.addEventListener("click", function (event) {
      var button = event.target.closest("button");

      if (!button) {
        return;
      }

      var item = button.closest(".task-item");

      if (!item) {
        return;
      }

      var id = item.dataset.id;

      if (button.classList.contains("act-edit")) {
        var task = TaskStore.get(id);

        if (task) {
          openEditor(task);
        }
      } else if (button.classList.contains("act-duplicate")) {
        duplicateTask(id);
      } else if (button.classList.contains("act-delete")) {
        requestDelete(id);
      }
    });

    /* ---------------------------- shortcuts ---------------------------- */

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!dom.confirmOverlay.hidden) {
          cancelDelete();

          return;
        }

        if (!dom.taskOverlay.hidden) {
          closeEditor();

          return;
        }

        if (!dom.searchRow.hidden) {
          closeSearch(true);
        }

        return;
      }

      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      if (isTextEntry(event.target)) {
        return;
      }

      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        openEditor(null);
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        openSearch();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        checkTimeSensitiveState();
      }
    });
  }

  /* =======================================================================
     INITIALISATION
     ======================================================================= */

  function reportNotices(notices) {
    notices.forEach(function (notice) {
      var message = META_MESSAGES[notice];

      if (!message) {
        return;
      }

      showToast(message, {
        duration: notice === "storage-unavailable" ? 9000 : 4500,
      });
    });

    if (notices.indexOf("storage-unavailable") !== -1) {
      state.storageWarned = true;
    }
  }

  /** One orchestrated opening: the rail draws itself down the board. */
  function playOpening() {
    dom.widget.classList.add("is-booting");

    global.setTimeout(function () {
      dom.widget.classList.remove("is-booting");
    }, 700);
  }

  function init() {
    cacheElements();
    bindEvents();
    playOpening();

    TaskStorage.load()
      .then(function (result) {
        TaskStore.replaceAll(result.tasks);

        render();
        reportNotices(result.notices);
      })
      .catch(function (error) {
        console.error("Todo widget: could not load tasks", error);

        render();
        showToast("Tasks couldn't be loaded. Starting with an empty list.", {
          duration: 6000,
        });
      });

    startTimeWatcher();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.TodoWidget = {
    render: render,
    showToast: showToast,
    state: state,
  };
})(window);
