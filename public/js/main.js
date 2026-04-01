// Auth and tasks behavior for Donezo

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch (error) {
      const fallbackText = await response.text().catch(() => "");
      return { error: fallbackText || "Unexpected server response" };
    }
  }

  const text = await response.text();
  return { error: text || "Unexpected server response" };
}


let csrfTokenPromise = null;

function shouldAttachCsrf(method = "GET") {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
}

async function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = (async () => {
      const response = await fetch("/csrf-token", { credentials: "include" });
      const data = await parseApiResponse(response);

      if (!response.ok || !data.csrfToken) {
        throw new Error(data.error || "Unable to retrieve CSRF token");
      }

      return data.csrfToken;
    })().catch((error) => {
      csrfTokenPromise = null;
      throw error;
    });
  }

  return csrfTokenPromise;
}

async function apiFetch(url, options = {}, retryOnCsrfFailure = true) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  if (shouldAttachCsrf(method) && !headers.has("x-csrf-token")) {
    const csrfToken = await getCsrfToken();
    headers.set("x-csrf-token", csrfToken);
  }

  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });

  if (response.status === 403 && shouldAttachCsrf(method) && retryOnCsrfFailure) {
    csrfTokenPromise = null;
    return apiFetch(url, options, false);
  }

  return response;
}

const focusState = {
  taskId: null,
  sessionId: null,
  startedAt: null,
  timerIntervalId: null,
  timerEl: null,
  sessionCardEl: null,
  pipWindow: null,
  isInPiP: false,
  pipOriginalParent: null,
  pipOriginalNextSibling: null,
  quoteTimeoutIds: [],
  quoteTypingIntervalId: null,
  currentQuoteToken: 0,
  lastQuote: {
    general: null,
    persistence: null,
    completion: null,
    timed: null,
  },
  filter: "big-three",
  allTasks: [],
};

const focusQuotes = {
  general: [
    "You showed up. That’s the hardest part.",
    "Just this task for now.",
    "Small progress still counts.",
    "Stay with this moment.",
    "One step is enough.",
    "No rush. Just focus.",
    "Your effort is doing the work.",
    "Momentum builds quietly.",
    "You’re moving forward.",
    "Keep going — this moment counts.",
    "Consistency beats intensity.",
    "It doesn’t have to be perfect.",
    "Progress, not perfection.",
    "Just explore the next step.",
    "You only need to begin.",
    "Even five minutes matters.",
  ],
  persistence: [
    "Still here. Still working.",
    "Stay curious about the next step.",
    "Keep the thread going.",
    "You’re building momentum.",
  ],
  completion: [
    "Nice work staying with it.",
    "That effort mattered.",
    "You gave it your attention.",
    "One focused session down.",
  ],
  timed: {
    twoMinutes: "Starting was the hardest part.",
    fiveMinutes: "You’re finding your rhythm.",
    tenMinutes: "Momentum is building.",
  },
};

const dashboardTaskState = {
  filter: "task-list",
  allTasks: [],
};

function formatFocusDuration(totalSeconds) {
  const safeSeconds = Math.max(0, parseInt(totalSeconds, 10) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getFocusTimerEl() {
  if (focusState.timerEl && focusState.timerEl.isConnected) {
    return focusState.timerEl;
  }

  const fromMainDoc = document.getElementById("focusTimer");
  if (fromMainDoc) {
    focusState.timerEl = fromMainDoc;
    return fromMainDoc;
  }

  const fromPiPDoc = focusState.pipWindow?.document?.getElementById("focusTimer");
  if (fromPiPDoc) {
    focusState.timerEl = fromPiPDoc;
    return fromPiPDoc;
  }

  return null;
}

function getFocusSessionCardEl() {
  if (focusState.sessionCardEl && focusState.sessionCardEl.isConnected) {
    return focusState.sessionCardEl;
  }

  const fromMainDoc = document.querySelector(".focus-session-card");
  if (fromMainDoc) {
    focusState.sessionCardEl = fromMainDoc;
    return fromMainDoc;
  }

  const fromPiPDoc = focusState.pipWindow?.document?.querySelector(".focus-session-card");
  if (fromPiPDoc) {
    focusState.sessionCardEl = fromPiPDoc;
    return fromPiPDoc;
  }

  return null;
}

function renderFocusTimer() {
  const timerEl = getFocusTimerEl();
  if (!timerEl) return;

  if (!focusState.startedAt) {
    timerEl.textContent = "00:00";
    return;
  }

  const elapsedSeconds = Math.floor((Date.now() - focusState.startedAt) / 1000);
  timerEl.textContent = formatFocusDuration(elapsedSeconds);
}

function startFocusTimer() {
  if (focusState.timerIntervalId) {
    window.clearInterval(focusState.timerIntervalId);
  }
  renderFocusTimer();
  focusState.timerIntervalId = window.setInterval(renderFocusTimer, 1000);
}

function stopFocusTimer() {
  if (focusState.timerIntervalId) {
    window.clearInterval(focusState.timerIntervalId);
    focusState.timerIntervalId = null;
  }
}

function isDocumentPictureInPictureSupported() {
  return Boolean(window.documentPictureInPicture?.requestWindow);
}

function updateFocusPiPToggleButton() {
  const toggleBtn = document.getElementById("focusPiPToggleBtn");
  const iconEl = document.getElementById("focusPiPIcon");
  if (!toggleBtn || !iconEl) return;

  const isRunning = Boolean(focusState.taskId);
  const supported = isDocumentPictureInPictureSupported();
  toggleBtn.hidden = !isRunning;
  toggleBtn.disabled = !isRunning || !supported;

  if (focusState.isInPiP) {
    toggleBtn.setAttribute("aria-label", "Pop timer back into page");
    toggleBtn.setAttribute("title", "Pop in timer");
    iconEl.textContent = "⤡";
  } else {
    toggleBtn.setAttribute("aria-label", "Pop out focus timer");
    toggleBtn.setAttribute("title", "Pop out timer");
    iconEl.textContent = "⤢";
  }
}

function copyStylesToPiPWindow(pipWindow) {
  if (!pipWindow?.document) return;
  const head = pipWindow.document.head;
  if (!head) return;

  document.querySelectorAll('link[rel="stylesheet"]').forEach((linkEl) => {
    const clone = linkEl.cloneNode(true);
    head.appendChild(clone);
  });
}

function returnFocusWidgetToMainPage() {
  const sessionCard = getFocusSessionCardEl();
  if (!sessionCard || !focusState.pipOriginalParent) return;

  if (
    focusState.pipOriginalNextSibling &&
    focusState.pipOriginalNextSibling.parentNode === focusState.pipOriginalParent
  ) {
    focusState.pipOriginalParent.insertBefore(
      sessionCard,
      focusState.pipOriginalNextSibling,
    );
  } else {
    focusState.pipOriginalParent.appendChild(sessionCard);
  }

  focusState.isInPiP = false;
  focusState.pipWindow = null;
  focusState.pipOriginalParent = null;
  focusState.pipOriginalNextSibling = null;
  updateFocusPiPToggleButton();
}

async function openFocusWidgetInPiP() {
  if (!isDocumentPictureInPictureSupported()) {
    Toast.show({
      message: "Picture-in-picture is not supported in this browser yet.",
      type: "error",
      duration: 3200,
    });
    return;
  }

  if (focusState.isInPiP) return;

  const sessionCard = getFocusSessionCardEl();
  if (!sessionCard) return;

  focusState.pipOriginalParent = sessionCard.parentNode;
  focusState.pipOriginalNextSibling = sessionCard.nextSibling;

  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 440,
      height: 360,
    });
    copyStylesToPiPWindow(pipWindow);
    pipWindow.document.body.className = "pip-focus-window";
    pipWindow.document.body.style.margin = "0";
    pipWindow.document.body.style.padding = "12px";
    pipWindow.document.body.appendChild(sessionCard);

    focusState.pipWindow = pipWindow;
    focusState.isInPiP = true;
    updateFocusPiPToggleButton();
    updateFocusModeControls({
      running: Boolean(focusState.taskId),
      hasTask: Boolean(document.getElementById("focusTaskSelect")?.value),
    });

    pipWindow.addEventListener("pagehide", () => {
      returnFocusWidgetToMainPage();
      updateFocusModeControls({
        running: Boolean(focusState.taskId),
        hasTask: Boolean(document.getElementById("focusTaskSelect")?.value),
      });
    });
  } catch (error) {
    focusState.pipOriginalParent = null;
    focusState.pipOriginalNextSibling = null;
    updateFocusPiPToggleButton();
    console.error("Could not open focus widget in picture-in-picture:", error);
    Toast.show({
      message: "Could not open picture-in-picture right now.",
      type: "error",
      duration: 3000,
    });
  }
}

function closeFocusWidgetPiP() {
  if (!focusState.isInPiP) return;
  if (focusState.pipWindow && !focusState.pipWindow.closed) {
    focusState.pipWindow.close();
  } else {
    returnFocusWidgetToMainPage();
  }
}

function getFocusQuoteEl() {
  return document.getElementById("focusQuoteText");
}

function clearFocusQuoteTimers() {
  focusState.quoteTimeoutIds.forEach((timeoutId) =>
    window.clearTimeout(timeoutId),
  );
  focusState.quoteTimeoutIds = [];
}

function hasCompletedTaskToday(tasks = focusState.allTasks) {
  const now = new Date();
  const dayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const nextDay = dayStart + 24 * 60 * 60 * 1000;

  return (
    Array.isArray(tasks) &&
    tasks.some((task) => {
      if (task?.status !== "completed") return false;
      const completedAt = new Date(task?.completedAt || 0).getTime();
      return (
        Number.isFinite(completedAt) &&
        completedAt >= dayStart &&
        completedAt < nextDay
      );
    })
  );
}

function pickFocusQuote(category) {
  const list =
    category === "timed"
      ? Object.values(focusQuotes.timed)
      : focusQuotes[category];
  if (!Array.isArray(list) || list.length === 0) return "";

  const previousQuote = focusState.lastQuote[category] || null;
  let nextQuote = list[Math.floor(Math.random() * list.length)];

  if (list.length > 1 && nextQuote === previousQuote) {
    const alternatives = list.filter((quote) => quote !== previousQuote);
    nextQuote =
      alternatives[Math.floor(Math.random() * alternatives.length)] ||
      nextQuote;
  }

  focusState.lastQuote[category] = nextQuote;
  return nextQuote;
}

function setFocusQuoteText(message, { typewriter = true } = {}) {
  const quoteEl = getFocusQuoteEl();
  if (!quoteEl) return;

  focusState.currentQuoteToken += 1;
  const token = focusState.currentQuoteToken;

  if (focusState.quoteTypingIntervalId) {
    window.clearInterval(focusState.quoteTypingIntervalId);
    focusState.quoteTypingIntervalId = null;
  }

  const nextMessage = String(message || "");
  quoteEl.textContent = "";

  if (!typewriter || !nextMessage) {
    quoteEl.classList.remove("is-typing");
    quoteEl.textContent = nextMessage;
    return;
  }

  quoteEl.classList.add("is-typing");
  let index = 0;

  focusState.quoteTypingIntervalId = window.setInterval(() => {
    if (token !== focusState.currentQuoteToken) {
      window.clearInterval(focusState.quoteTypingIntervalId);
      focusState.quoteTypingIntervalId = null;
      quoteEl.classList.remove("is-typing");
      return;
    }

    index += 1;
    quoteEl.textContent = nextMessage.slice(0, index);

    if (index >= nextMessage.length) {
      window.clearInterval(focusState.quoteTypingIntervalId);
      focusState.quoteTypingIntervalId = null;
      quoteEl.classList.remove("is-typing");
    }
  }, 32);
}

function showFocusQuoteByCategory(category) {
  const quote = pickFocusQuote(category);
  setFocusQuoteText(quote, { typewriter: true });
}

function scheduleSessionNudges() {
  clearFocusQuoteTimers();
  if (!focusState.startedAt || !focusState.taskId) return;

  const milestones = [
    { offsetMs: 2 * 60 * 1000, message: focusQuotes.timed.twoMinutes },
    { offsetMs: 5 * 60 * 1000, message: focusQuotes.timed.fiveMinutes },
    { offsetMs: 10 * 60 * 1000, message: focusQuotes.timed.tenMinutes },
  ];

  milestones.forEach(({ offsetMs, message }) => {
    const remainingMs = focusState.startedAt + offsetMs - Date.now();
    if (remainingMs <= 0) return;

    const timeoutId = window.setTimeout(() => {
      if (!focusState.taskId) return;
      setFocusQuoteText(message, { typewriter: true });
    }, remainingMs);

    focusState.quoteTimeoutIds.push(timeoutId);
  });
}

function getFocusTasksByFilter(tasks, filter) {
  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((task) => task.status === "active")
    : [];

  if (filter === "big-three") {
    return activeTasks.filter((task) => Boolean(task.isBigThree)).slice(0, 3);
  }

  if (filter === "effort") {
    return [...activeTasks].sort((a, b) => {
      const effortA = Number(a?.effortLevel) || 5;
      const effortB = Number(b?.effortLevel) || 5;
      if (effortA !== effortB) return effortA - effortB;

      const createdA = new Date(a?.createdAt || 0).getTime();
      const createdB = new Date(b?.createdAt || 0).getTime();
      return createdB - createdA;
    });
  }

  return [...activeTasks].sort((a, b) => {
    const createdA = new Date(a?.createdAt || 0).getTime();
    const createdB = new Date(b?.createdAt || 0).getTime();
    return createdB - createdA;
  });
}

function updateFocusFilterTabs(selectedFilter, { running = false } = {}) {
  const tabButtons = document.querySelectorAll(".focus-task-tab");
  if (!tabButtons.length) return;

  tabButtons.forEach((buttonEl) => {
    const isActive = buttonEl.dataset.filter === selectedFilter;
    buttonEl.classList.toggle("is-active", isActive);
    buttonEl.setAttribute("aria-selected", isActive ? "true" : "false");
    buttonEl.disabled = Boolean(running);
  });
}

function bindFocusFilterTabs() {
  const tabButtons = document.querySelectorAll(".focus-task-tab");
  if (!tabButtons.length) return;

  tabButtons.forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      if (focusState.taskId) return;

      const filter = buttonEl.dataset.filter || "big-three";
      if (filter === focusState.filter) return;

      focusState.filter = filter;
      updateFocusTaskOptions(focusState.allTasks);
    });
  });

  updateFocusFilterTabs(focusState.filter, {
    running: Boolean(focusState.taskId),
  });
}

function updateFocusModeControls({ running, hasTask } = {}) {
  const selectEl = document.getElementById("focusTaskSelect");
  const taskListEl = document.getElementById("focusTaskList");
  const startBtn = document.getElementById("focusStartBtn");
  const stopBtn = document.getElementById("focusStopBtn");
  const completeBtn = document.getElementById("focusCompleteBtn");
  if (selectEl) selectEl.disabled = running;
  if (taskListEl) {
    taskListEl.setAttribute(
      "aria-disabled",
      Boolean(running) ? "true" : "false",
    );
    taskListEl.querySelectorAll(".focus-task-option").forEach((buttonEl) => {
      buttonEl.disabled = Boolean(running);
    });
  }

  updateFocusFilterTabs(focusState.filter, { running: Boolean(running) });

  if (startBtn) {
    startBtn.hidden = Boolean(running) || focusState.isInPiP;
    startBtn.disabled = Boolean(running);
  }
  updateFocusPiPToggleButton();
  if (stopBtn) {
    stopBtn.hidden = !Boolean(running);
    stopBtn.disabled = !Boolean(running);
  }
  if (completeBtn) {
    completeBtn.hidden = !Boolean(running);
    completeBtn.disabled = !Boolean(running);
  }
}

function syncFocusTaskSelection(taskListEl, selectedTaskId) {
  if (!taskListEl) return;

  const selectedValue = String(selectedTaskId || "");
  taskListEl.querySelectorAll(".focus-task-list-item").forEach((item) => {
    const isSelected = item.dataset.taskId === selectedValue;
    item.classList.toggle("is-selected", isSelected);
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
}

function updateFocusTaskOptions(tasks) {
  const selectEl = document.getElementById("focusTaskSelect");
  const taskListEl = document.getElementById("focusTaskList");
  if (!selectEl) return;

  const previousValue = selectEl.value;
  const filteredTasks = getFocusTasksByFilter(tasks, focusState.filter);

  selectEl.innerHTML = "";
  if (taskListEl) taskListEl.innerHTML = "";

  if (filteredTasks.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "You have no active tasks. Make one now!";
    selectEl.appendChild(option);

    if (taskListEl) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "big-three-item focus-task-list-item focus-task-empty";

      const sentence = document.createElement("span");
      sentence.textContent = "You have no active tasks. ";

      const createTaskLink = document.createElement("a");
      createTaskLink.href = "/dashboard.html";
      createTaskLink.className = "focus-task-empty-link highlight-on-parent-hover";
      createTaskLink.textContent = "Make one now!";

      sentence.append(createTaskLink);
      emptyItem.append(sentence);
      taskListEl.appendChild(emptyItem);
    }

    updateFocusModeControls({
      running: Boolean(focusState.taskId),
      hasTask: false,
    });
    return;
  }

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = "Select a task";
  selectEl.appendChild(placeholderOption);

  filteredTasks.forEach((task) => {
    const option = document.createElement("option");
    const taskId = String(task._id);
    option.value = taskId;
    option.textContent = task.description || "Untitled task";
    selectEl.appendChild(option);

    if (taskListEl) {
      const item = document.createElement("li");
      item.className = "big-three-item focus-task-list-item";
      item.dataset.taskId = taskId;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");

      const optionButton = document.createElement("button");
      optionButton.type = "button";
      optionButton.className = "focus-task-option";
      optionButton.textContent = task.description || "Untitled task";
      optionButton.addEventListener("click", () => {
        if (focusState.taskId) return;
        selectEl.value = taskId;
        syncFocusTaskSelection(taskListEl, taskId);
        updateFocusModeControls({ running: false, hasTask: true });
      });

      item.append(optionButton);
      taskListEl.appendChild(item);
    }
  });

  const runningTaskId = String(focusState.taskId || "");
  if (
    runningTaskId &&
    filteredTasks.some((task) => String(task._id) === runningTaskId)
  ) {
    selectEl.value = runningTaskId;
  } else if (
    previousValue &&
    filteredTasks.some((task) => String(task._id) === previousValue)
  ) {
    selectEl.value = previousValue;
  } else {
    selectEl.value = "";
  }

  const hasSelectedTaskInAnyList = focusState.allTasks.some(
    (task) =>
      task.status === "active" &&
      String(task._id) === String(focusState.taskId),
  );
  if (focusState.taskId && !hasSelectedTaskInAnyList) {
    void stopFocusSession("task_no_longer_active");
  }

  syncFocusTaskSelection(taskListEl, selectEl.value);
  updateFocusModeControls({
    running: Boolean(focusState.taskId),
    hasTask: Boolean(selectEl.value),
  });
}

async function loadFocusTasks() {
  const response = await apiFetch("/tasks", { credentials: "include" });
  if (!response.ok) {
    focusState.allTasks = [];
    updateFocusTaskOptions([]);
    return [];
  }

  const tasks = await response.json();
  focusState.allTasks = Array.isArray(tasks) ? tasks : [];
  updateFocusTaskOptions(focusState.allTasks);
  return focusState.allTasks;
}

function getFocusLogBody() {
  return document.getElementById("focus-log-body");
}

function getTodayIsoRange() {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function computeSessionDurationMs(session) {
  const explicitDurationMs = Number(session?.durationMs);
  if (Number.isFinite(explicitDurationMs) && explicitDurationMs > 0) {
    return explicitDurationMs;
  }

  const startedAt = new Date(session?.startedAt || 0);
  if (Number.isNaN(startedAt.getTime())) return 0;

  const endedAt = session?.endedAt ? new Date(session.endedAt) : new Date();
  if (Number.isNaN(endedAt.getTime())) return 0;

  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

function summarizeDailyFocusSessions(sessions) {
  const totalsByTask = new Map();

  sessions.forEach((session) => {
    const taskId = String(
      session?.taskId || session?.taskDescription || "unknown-task",
    );
    const taskDescription =
      String(session?.taskDescription || "Deleted task").trim() ||
      "Deleted task";

    if (!totalsByTask.has(taskId)) {
      totalsByTask.set(taskId, {
        taskDescription,
        sessions: 0,
        durationMs: 0,
      });
    }

    const entry = totalsByTask.get(taskId);
    entry.sessions += 1;
    entry.durationMs += computeSessionDurationMs(session);
  });

  return Array.from(totalsByTask.values()).sort((a, b) => {
    if (b.durationMs !== a.durationMs) return b.durationMs - a.durationMs;
    if (b.sessions !== a.sessions) return b.sessions - a.sessions;
    return a.taskDescription.localeCompare(b.taskDescription);
  });
}

function formatSessionMinutes(durationMs) {
  const minutes = Math.max(1, Math.round((Number(durationMs) || 0) / 60000));
  return `${minutes} min`;
}

async function updateFocusLogWidget() {
  const body = getFocusLogBody();
  if (!body) return;

  const { from, to } = getTodayIsoRange();
  const query = new URLSearchParams({ from, to }).toString();

  try {
    const response = await apiFetch(`/focus-sessions?${query}`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data?.error || "Could not load focus sessions.");
    }

    const sessions = Array.isArray(data) ? data : [];
    const summary = summarizeDailyFocusSessions(sessions);

    if (summary.length === 0) {
      body.innerHTML =
        '<p class="focus-log-note">No focused tasks yet today. Start a focus session to track one.</p>';
      return;
    }

    body.innerHTML = "";
    const list = document.createElement("ul");
    list.className = "focus-log-list";

    summary.forEach((entry) => {
      const sessionLabel = entry.sessions === 1 ? "session" : "sessions";
      const item = document.createElement("li");
      item.className = "focus-log-item";

      const title = document.createElement("span");
      title.className = "focus-log-item-title";
      title.textContent = entry.taskDescription;

      const meta = document.createElement("span");
      meta.className = "focus-log-item-meta";
      meta.textContent = `${entry.sessions} ${sessionLabel} - ${formatSessionMinutes(entry.durationMs)}`;

      item.append(title, meta);
      list.appendChild(item);
    });

    body.appendChild(list);
  } catch (error) {
    console.error("Failed to update focus log widget:", error);
    body.innerHTML =
      '<p class="focus-log-note">Could not load today\'s focus log right now.</p>';
  }
}

async function stopFocusSession(reason = "manual_stop") {
  const statusEl = document.getElementById("focus-status");
  const isRunning = Boolean(focusState.taskId);
  const endingTaskId = focusState.taskId;
  const endedTask = focusState.allTasks.find(
    (task) => String(task?._id) === String(endingTaskId),
  );
  const taskMarkedCompleted = endedTask?.status === "completed";
  const apiReason = [
    "completed_task",
    "manual_stop",
    "timeout",
    "app_closed",
  ].includes(reason)
    ? reason
    : "manual_stop";
  let stopError = null;

  if (isRunning) {
    try {
      const response = await apiFetch("/focus-sessions/stop", {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: apiReason }),
      });

      if (!response.ok && response.status !== 404) {
        const payload = await parseApiResponse(response);
        stopError = payload?.error || "Could not save focus session.";
      }
    } catch (error) {
      console.error("Stop focus session request failed:", error);
      stopError = "Could not save focus session.";
    }
  }

  stopFocusTimer();
  closeFocusWidgetPiP();
  clearFocusQuoteTimers();
  focusState.taskId = null;
  focusState.sessionId = null;
  focusState.startedAt = null;
  updateFocusModeControls({ running: false });
  renderFocusTimer();

  if (isRunning) {
    await updateFocusLogWidget();
  }

  if (!statusEl || !isRunning) return;

  if (reason === "completed_task" || taskMarkedCompleted) {
    statusEl.textContent =
      "Focus session ended because this task was completed.";
    showFocusQuoteByCategory("completion");
  } else if (reason === "task_no_longer_active") {
    statusEl.textContent =
      "Focus session ended because the task is no longer active.";
  } else {
    statusEl.textContent = "Focus session stopped.";
  }

  Toast.show({
    message: "Focus timer ended.",
    type: "success",
    duration: 2500,
  });

  if (stopError) {
    Toast.show({ message: stopError, type: "error", duration: 3000 });
  }
}

async function completeTask(taskId) {
  if (!taskId) return { ok: false, error: "Select a task first." };

  const task = focusState.allTasks.find(
    (entry) => String(entry?._id) === String(taskId),
  );
  const payload = { status: "completed" };
  if (Boolean(task?.isBigThree)) {
    payload.isBigThree = false;
  }

  try {
    const updateResponse = await apiFetch(`/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const updateData = await parseApiResponse(updateResponse);
    if (!updateResponse.ok) {
      return {
        ok: false,
        error: updateData?.error || "Could not complete task.",
      };
    }

    return { ok: true };
  } catch (error) {
    console.error("Completing focus task failed:", error);
    return { ok: false, error: "Could not complete task." };
  }
}

async function initFocusMode() {
  const selectEl = document.getElementById("focusTaskSelect");
  const startBtn = document.getElementById("focusStartBtn");
  const pipToggleBtn = document.getElementById("focusPiPToggleBtn");
  const stopBtn = document.getElementById("focusStopBtn");
  const completeBtn = document.getElementById("focusCompleteBtn");
  const statusEl = document.getElementById("focus-status");
  if (!selectEl || !startBtn || !pipToggleBtn || !stopBtn || !completeBtn || !statusEl) return;
  focusState.timerEl = document.getElementById("focusTimer");
  focusState.sessionCardEl = document.querySelector(".focus-session-card");

  bindFocusFilterTabs();
  setFocusQuoteText("", { typewriter: false });
  updateFocusPiPToggleButton();

  try {
    await loadFocusTasks();
  } catch (error) {
    console.error("Focus task preload failed:", error);
    updateFocusTaskOptions([]);
  }

  window.setTimeout(() => {
    showFocusQuoteByCategory("general");
  }, 220);

  startBtn.addEventListener("click", async () => {
    const selectedTaskId = selectEl.value;
    const selectedTaskLabel =
      selectEl.options[selectEl.selectedIndex]?.text || "";
    if (!selectedTaskId) {
      Toast.show({
        message: "Decide what we should focus on first!",
        type: "error",
        duration: 2500,
      });
      return;
    }

    if (focusState.taskId) {
      return;
    }

    startBtn.disabled = true;

    try {
      const response = await apiFetch("/focus-sessions/start", {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: selectedTaskId }),
      });
      const payload = await parseApiResponse(response);

      if (!response.ok) {
        Toast.show({
          message: payload?.error || "Could not start focus session.",
          type: "error",
          duration: 3000,
        });
        return;
      }

      const parsedStartedAt = new Date(payload?.startedAt || Date.now());

      focusState.sessionId = payload?._id || null;
      focusState.taskId = selectedTaskId;
      focusState.startedAt = Number.isNaN(parsedStartedAt.getTime())
        ? Date.now()
        : parsedStartedAt.getTime();
      updateFocusModeControls({ running: true, hasTask: true });
      startFocusTimer();
      const quoteCategory = hasCompletedTaskToday() ? "persistence" : "general";
      showFocusQuoteByCategory(quoteCategory);
      scheduleSessionNudges();
      statusEl.textContent = `Focused on: ${selectedTaskLabel}`;
      Toast.show({
        message: "Focus timer started.",
        type: "success",
        duration: 2500,
      });
      await updateFocusLogWidget();
    } catch (error) {
      console.error("Start focus session request failed:", error);
      Toast.show({
        message: "Could not start focus session.",
        type: "error",
        duration: 3000,
      });
    } finally {
      if (!focusState.taskId) {
        updateFocusModeControls({
          running: false,
          hasTask: Boolean(selectEl.value),
        });
      }
    }
  });

  stopBtn.addEventListener("click", async () => {
    await stopFocusSession("manual_stop");
  });

  pipToggleBtn.addEventListener("click", async () => {
    if (!focusState.taskId) return;
    if (focusState.isInPiP) {
      closeFocusWidgetPiP();
      return;
    }
    await openFocusWidgetInPiP();
  });

  completeBtn.addEventListener("click", async () => {
    if (!focusState.taskId) return;

    completeBtn.disabled = true;
    stopBtn.disabled = true;

    const completion = await completeTask(focusState.taskId);
    if (!completion.ok) {
      Toast.show({ message: completion.error, type: "error", duration: 3000 });
      updateFocusModeControls({
        running: Boolean(focusState.taskId),
        hasTask: Boolean(selectEl.value),
      });
      return;
    }

    await stopFocusSession("completed_task");
    await loadFocusTasks();
  });
}

function getTodayDateRangeIso() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function getCurrentWeekDateRangeIso() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;

  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  monday.setDate(monday.getDate() - daysFromMonday);

  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  return { startIso: monday.toISOString(), endIso: nextMonday.toISOString(), monday };
}

function formatDailyFocusDuration(durationMs) {
  const totalMinutes = Math.round((Number(durationMs) || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes} min`;
  if (minutes <= 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function getCompletedTaskCountToday(tasks = []) {
  const now = new Date();
  const dayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const nextDay = dayStart + 24 * 60 * 60 * 1000;

  if (!Array.isArray(tasks)) return 0;

  return tasks.reduce((count, task) => {
    if (task?.status !== "completed") return count;
    const completedAt = new Date(task?.completedAt || 0).getTime();
    if (
      Number.isFinite(completedAt) &&
      completedAt >= dayStart &&
      completedAt < nextDay
    ) {
      return count + 1;
    }
    return count;
  }, 0);
}

function getCompletedTaskCountInRange(tasks = [], startMs = 0, endMs = 0) {
  if (!Array.isArray(tasks)) return 0;

  return tasks.reduce((count, task) => {
    if (task?.status !== "completed") return count;
    const completedAt = new Date(task?.completedAt || 0).getTime();
    if (
      Number.isFinite(completedAt) &&
      completedAt >= startMs &&
      completedAt < endMs
    ) {
      return count + 1;
    }
    return count;
  }, 0);
}

function renderDailyReflectionStats({
  dateLabel,
  tasksFocused = "—",
  focusTimeLabel = "—",
  tasksCompleted = "—",
} = {}) {
  const dateEl = document.getElementById("dailyReflectionDate");
  const tasksEl = document.getElementById("dailyReflectionTasksFocused");
  const timeEl = document.getElementById("dailyReflectionFocusTime");
  const completedEl = document.getElementById("dailyReflectionTasksCompleted");

  if (!dateEl || !tasksEl || !timeEl || !completedEl) return;

  dateEl.textContent = dateLabel || new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  tasksEl.textContent = String(tasksFocused);
  timeEl.textContent = String(focusTimeLabel);
  completedEl.textContent = String(tasksCompleted);
}

function renderWeeklyReflectionStats({
  dateLabel,
  tasksFocused = "—",
  focusTimeLabel = "—",
  tasksCompleted = "—",
} = {}) {
  const dateEl = document.getElementById("weeklyReflectionDate");
  const tasksEl = document.getElementById("weeklyReflectionTasksFocused");
  const timeEl = document.getElementById("weeklyReflectionFocusTime");
  const completedEl = document.getElementById("weeklyReflectionTasksCompleted");

  if (!dateEl || !tasksEl || !timeEl || !completedEl) return;

  dateEl.textContent = dateLabel || "—";
  tasksEl.textContent = String(tasksFocused);
  timeEl.textContent = String(focusTimeLabel);
  completedEl.textContent = String(tasksCompleted);
}

async function refreshDailyReflectionStats() {
  const dateEl = document.getElementById("dailyReflectionDate");
  const tasksEl = document.getElementById("dailyReflectionTasksFocused");
  const timeEl = document.getElementById("dailyReflectionFocusTime");
  const completedEl = document.getElementById("dailyReflectionTasksCompleted");

  if (!dateEl || !tasksEl || !timeEl || !completedEl) return;

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  renderDailyReflectionStats({
    dateLabel: todayLabel,
    tasksFocused: "…",
    focusTimeLabel: "…",
    tasksCompleted: "…",
  });

  try {
    const { startIso, endIso } = getTodayDateRangeIso();
    const focusQuery = new URLSearchParams({ from: startIso, to: endIso }).toString();

    const [sessionsResponse, tasksResponse] = await Promise.all([
      apiFetch(`/focus-sessions?${focusQuery}`, {
        credentials: "include",
        cache: "no-store",
      }),
      apiFetch("/tasks", {
        credentials: "include",
        cache: "no-store",
      }),
    ]);

    const [sessionsData, tasksData] = await Promise.all([
      parseApiResponse(sessionsResponse),
      parseApiResponse(tasksResponse),
    ]);

    if (!sessionsResponse.ok) {
      throw new Error(sessionsData?.error || "Could not load focus sessions");
    }
    if (!tasksResponse.ok) {
      throw new Error(tasksData?.error || "Could not load tasks");
    }

    const sessions = Array.isArray(sessionsData) ? sessionsData : [];
    const tasks = Array.isArray(tasksData) ? tasksData : [];

    const focusedTaskIds = new Set(
      sessions
        .map((session) => session?.taskId)
        .filter((taskId) => taskId !== null && taskId !== undefined)
        .map((taskId) => String(taskId)),
    );

    const totalFocusMs = sessions.reduce(
      (sum, session) => sum + computeSessionDurationMs(session),
      0,
    );

    renderDailyReflectionStats({
      dateLabel: todayLabel,
      tasksFocused: focusedTaskIds.size,
      focusTimeLabel: formatDailyFocusDuration(totalFocusMs),
      tasksCompleted: getCompletedTaskCountToday(tasks),
    });
  } catch (error) {
    console.error("Could not refresh daily reflection stats:", error);
    renderDailyReflectionStats({
      dateLabel: todayLabel,
      tasksFocused: "—",
      focusTimeLabel: "—",
      tasksCompleted: "—",
    });
  }
}

async function refreshWeeklyReflectionStats() {
  const dateEl = document.getElementById("weeklyReflectionDate");
  const tasksEl = document.getElementById("weeklyReflectionTasksFocused");
  const timeEl = document.getElementById("weeklyReflectionFocusTime");
  const completedEl = document.getElementById("weeklyReflectionTasksCompleted");

  if (!dateEl || !tasksEl || !timeEl || !completedEl) return;

  const { startIso, endIso, monday } = getCurrentWeekDateRangeIso();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const weekLabel = `${monday.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  })} - ${sunday.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  renderWeeklyReflectionStats({
    dateLabel: weekLabel,
    tasksFocused: "…",
    focusTimeLabel: "…",
    tasksCompleted: "…",
  });

  try {
    const focusQuery = new URLSearchParams({ from: startIso, to: endIso }).toString();

    const [sessionsResponse, tasksResponse] = await Promise.all([
      apiFetch(`/focus-sessions?${focusQuery}`, {
        credentials: "include",
        cache: "no-store",
      }),
      apiFetch("/tasks", {
        credentials: "include",
        cache: "no-store",
      }),
    ]);

    const [sessionsData, tasksData] = await Promise.all([
      parseApiResponse(sessionsResponse),
      parseApiResponse(tasksResponse),
    ]);

    if (!sessionsResponse.ok) {
      throw new Error(sessionsData?.error || "Could not load focus sessions");
    }
    if (!tasksResponse.ok) {
      throw new Error(tasksData?.error || "Could not load tasks");
    }

    const sessions = Array.isArray(sessionsData) ? sessionsData : [];
    const tasks = Array.isArray(tasksData) ? tasksData : [];

    const focusedTaskIds = new Set(
      sessions
        .map((session) => session?.taskId)
        .filter((taskId) => taskId !== null && taskId !== undefined)
        .map((taskId) => String(taskId)),
    );

    const totalFocusMs = sessions.reduce(
      (sum, session) => sum + computeSessionDurationMs(session),
      0,
    );

    renderWeeklyReflectionStats({
      dateLabel: weekLabel,
      tasksFocused: focusedTaskIds.size,
      focusTimeLabel: formatDailyFocusDuration(totalFocusMs),
      tasksCompleted: getCompletedTaskCountInRange(
        tasks,
        new Date(startIso).getTime(),
        new Date(endIso).getTime(),
      ),
    });
  } catch (error) {
    console.error("Could not refresh weekly reflection stats:", error);
    renderWeeklyReflectionStats({
      dateLabel: weekLabel,
      tasksFocused: "—",
      focusTimeLabel: "—",
      tasksCompleted: "—",
    });
  }
}

function initDailyReflectionStatsWidget() {
  const dateEl = document.getElementById("dailyReflectionDate");
  if (!dateEl) return;

  refreshDailyReflectionStats();

  window.setInterval(refreshDailyReflectionStats, 60000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDailyReflectionStats();
  });

  window.addEventListener("focus", refreshDailyReflectionStats);
}

function initWeeklyReflectionStatsWidget() {
  const dateEl = document.getElementById("weeklyReflectionDate");
  if (!dateEl) return;

  refreshWeeklyReflectionStats();

  window.setInterval(refreshWeeklyReflectionStats, 60000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshWeeklyReflectionStats();
  });

  window.addEventListener("focus", refreshWeeklyReflectionStats);
}

async function initDailyEmailSettings() {
  const toggleEl = document.getElementById("dailyEmailToggle");
  const timeEl = document.getElementById("dailyEmailTime");
  const testBtn = document.getElementById("dailyEmailTestBtn");

  if (!toggleEl || !timeEl || !testBtn) return;

  const setInputsDisabled = (disabled) => {
    toggleEl.disabled = disabled;
    timeEl.disabled = disabled;
    testBtn.disabled = disabled;
  };

  const saveSettings = async () => {
    try {
      const response = await apiFetch("/settings/daily-email", {
        credentials: "include",
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyEmail: toggleEl.checked,
          dailyEmailTime: timeEl.value || "18:00",
        }),
      });

      const data = await parseApiResponse(response);
      if (!response.ok) {
        throw new Error(data?.error || "Unable to save daily email settings.");
      }

      Toast.show({
        message: "Daily reflection settings saved",
        type: "success",
        duration: 1800,
      });
    } catch (error) {
      console.error("Saving daily email settings failed:", error);
      Toast.show({
        message: error.message || "Could not save daily reflection settings.",
        type: "error",
        duration: 2600,
      });
    }
  };

  try {
    setInputsDisabled(true);
    const response = await apiFetch("/settings/daily-email", {
      credentials: "include",
      cache: "no-store",
    });

    const data = await parseApiResponse(response);
    if (!response.ok) {
      throw new Error(data?.error || "Unable to load daily email settings.");
    }

    toggleEl.checked = Boolean(data?.dailyEmail);
    timeEl.value = typeof data?.dailyEmailTime === "string" ? data.dailyEmailTime : "18:00";
  } catch (error) {
    console.error("Loading daily email settings failed:", error);
    Toast.show({
      message: "Could not load daily reflection settings.",
      type: "error",
      duration: 2600,
    });
  } finally {
    setInputsDisabled(false);
  }

  toggleEl.addEventListener("change", saveSettings);
  timeEl.addEventListener("change", saveSettings);

  testBtn.addEventListener("click", async () => {
    if (!toggleEl.checked) {
      Toast.show({
        message:
          'Unable to send daily reflection. Turn on "Daily Reflection" in settings to receive daily reflection emails.',
        type: "error",
        duration: 3200,
      });
      return;
    }

    testBtn.disabled = true;

    try {
      const response = await apiFetch("/settings/daily-email/test", {
        credentials: "include",
        method: "POST",
      });

      const data = await parseApiResponse(response);
      if (!response.ok) {
        throw new Error(data?.error || "Unable to send daily reflection. Turn on \"Daily Reflection\" in settings to receive daily reflection emails.");
      }

      Toast.show({
        message: "Test daily reflection email sent",
        type: "success",
        duration: 2600,
      });
    } catch (error) {
      console.error("Sending daily email test failed:", error);
      Toast.show({
        message: error.message || "Could not send test daily reflection email.",
        type: "error",
        duration: 3000,
      });
    } finally {
      testBtn.disabled = false;
    }
  });
}

async function initFeedbackForm() {
  const feedbackForm = document.getElementById("feedbackForm");
  if (!feedbackForm) return;

  const emailEl = document.getElementById("feedbackEmail");
  const subjectEl = document.getElementById("feedbackSubject");
  const messageEl = document.getElementById("feedbackMessage");
  const submitBtn = document.getElementById("feedbackSubmitBtn");

  try {
    const authResponse = await apiFetch("/auth-status", {
      credentials: "include",
      cache: "no-store",
    });
    const authData = await parseApiResponse(authResponse);

    if (!authResponse.ok || !authData?.loggedIn || !authData?.user?.email) {
      throw new Error("Please log in before sending feedback.");
    }

    if (emailEl) {
      emailEl.value = authData.user.email;
    }
  } catch (error) {
    Toast.show({
      message: error?.message || "Unable to load account email for feedback.",
      type: "error",
      duration: 3000,
    });
  }

  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const subject = subjectEl?.value?.trim() || "";
    const message = messageEl?.value?.trim() || "";

    if (!subject || !message) {
      Toast.show({
        message: "Please add a bug summary and details before sending.",
        type: "warning",
        duration: 2500,
      });
      return;
    }

    submitBtn.disabled = true;

    try {
      const response = await apiFetch("/feedback/report-bug", {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message }),
      });

      const data = await parseApiResponse(response);
      if (!response.ok) {
        throw new Error(data?.error || "Unable to send feedback right now.");
      }

      feedbackForm.reset();
      if (emailEl) {
        emailEl.value = data?.fromEmail || emailEl.value;
      }

      Toast.show({
        message: "Thanks! Your bug report was emailed to support.",
        type: "success",
        duration: 2800,
      });
    } catch (error) {
      Toast.show({
        message: error?.message || "Unable to send feedback right now.",
        type: "error",
        duration: 3200,
      });
    } finally {
      submitBtn.disabled = false;
    }
  });
}


document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM Fully Loaded - JavaScript Running");

  // Page flags let us adjust behavior for standalone login/register views
  const isLoginPage = document.body.classList.contains("login-page");
  const isRegisterPage = document.body.classList.contains("register-page");
  const currentPath = window.location.pathname;
  const protectedPaths = new Set([
    "/dashboard.html",
    "/calendar-page.html",
    "/profile-page.html",
    "/settings-page.html",
    "/feedback-page.html",
  ]);
  const isProtectedPage = protectedPaths.has(currentPath);
  const isHomePage = currentPath === "/" || currentPath === "/index.html";

  // Registration handler (used on register.html)
  const registerForm = document.getElementById("registerForm");
  if (registerForm) {
    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const firstName = document
        .getElementById("registerFirstName")
        ?.value.trim();
      const lastName = document
        .getElementById("registerLastName")
        ?.value.trim();
      const email = document.getElementById("registerEmail")?.value.trim();
      const password = document.getElementById("registerPassword").value;
      const confirmPassword = document.getElementById("registerConfirm").value;

      if (!firstName || !lastName || !email) {
        alert("Please fill in first name, last name, and email.");
        return;
      }

      // Simple client-side guard to match the confirm password box
      if (password !== confirmPassword) {
        alert("Passwords do not match.");
        return;
      }

      try {
        const response = await apiFetch("/register", {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName, lastName, email, password }),
        });

        const data = await parseApiResponse(response);

        // Check if registration went alright
        if (response.ok) {
          const sentFlag = data?.emailDeliveryFailed ? "0" : "1";
          const query = new URLSearchParams({
            sent: sentFlag,
            email,
          }).toString();
          window.location.href = `/verification-status.html?${query}`;
        } else {
          alert("Registration failed: " + (data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("Registration request failed:", error);
        alert("Registration failed due to a network/server issue.");
      }
    });
  }

  const verificationPage = document.getElementById("verification-status-page");
  if (verificationPage) {
    const params = new URLSearchParams(window.location.search);
    const sent = params.get("sent") === "1";
    const email = (params.get("email") || "").trim();

    const messageEl = document.getElementById("verificationStatusMessage");
    const emailEl = document.getElementById("verificationStatusEmail");
    const resendBtn = document.getElementById("resendVerificationBtn");

    if (messageEl) {
      messageEl.textContent = sent
        ? "Verification email was sent."
        : "Verification email was not sent.";
    }

    if (emailEl) {
      emailEl.textContent = email ? `Email: ${email}` : "Email unavailable";
    }

    resendBtn?.addEventListener("click", async () => {
      if (!email) {
        alert("No email found for this registration. Please sign up again.");
        return;
      }

      resendBtn.disabled = true;

      try {
        const response = await apiFetch("/resend-verification", {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        const data = await parseApiResponse(response);
        if (response.ok) {
          alert(data.message || "Verification email sent.");
          Toast.show({
            message: "Verification email resent",
            type: "success",
            duration: 2200,
          });
        } else {
          alert(data.error || "Could not resend verification email.");
          Toast.show({
            message: "Resend failed",
            type: "error",
            duration: 2200,
          });
        }
      } catch (error) {
        console.error("Resend verification request failed:", error);
        alert("Network error while resending verification email.");
      } finally {
        resendBtn.disabled = false;
      }
    });
  }

  const forgotPasswordForm = document.getElementById("forgotPasswordForm");
  if (forgotPasswordForm) {
    forgotPasswordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = document
        .getElementById("forgotPasswordEmail")
        ?.value.trim();

      if (!email) {
        alert("Please enter your email.");
        return;
      }

      try {
        const response = await apiFetch("/forgot-password", {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        const data = await parseApiResponse(response);
        if (response.ok) {
          alert(
            data.message ||
              "If that account exists, a password reset email has been sent.",
          );
          Toast.show({
            message: "Reset email request sent",
            type: "success",
            duration: 2400,
          });
        } else {
          alert(data.error || "Could not process reset request.");
        }
      } catch (error) {
        console.error("Forgot password request failed:", error);
        alert("Network error while requesting password reset.");
      }
    });
  }

  const resetPasswordForm = document.getElementById("resetPasswordForm");
  if (resetPasswordForm) {
    const params = new URLSearchParams(window.location.search);
    const emailInput = document.getElementById("resetPasswordEmail");
    const tokenInput = document.getElementById("resetPasswordToken");

    if (emailInput && params.get("email"))
      emailInput.value = params.get("email");
    if (tokenInput && params.get("token"))
      tokenInput.value = params.get("token");

    resetPasswordForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const email = emailInput?.value.trim();
      const token = tokenInput?.value.trim();
      const newPassword =
        document.getElementById("resetPasswordNew")?.value || "";
      const confirmPassword =
        document.getElementById("resetPasswordConfirm")?.value || "";

      if (!email || !token || !newPassword) {
        alert("Please complete all required fields.");
        return;
      }

      if (newPassword !== confirmPassword) {
        alert("Passwords do not match.");
        return;
      }

      try {
        const response = await apiFetch("/reset-password", {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, token, newPassword }),
        });

        const data = await parseApiResponse(response);
        if (response.ok) {
          alert(data.message || "Password reset successful.");
          Toast.show({
            message: "Password updated",
            type: "success",
            duration: 2200,
          });
          window.location.href = "/login.html";
        } else {
          alert(data.error || "Unable to reset password.");
        }
      } catch (error) {
        console.error("Reset password request failed:", error);
        alert("Network error while resetting password.");
      }
    });
  }

  // Login handler (used on login.html)
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    const authError = new URLSearchParams(window.location.search).get("error");
    if (authError === "sso_failed") {
      Toast.show({
        message: "Social sign-in failed. Please try again.",
        type: "error",
        duration: 3500,
      });
    }

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const email = document.getElementById("loginEmail").value.trim();
      const password = document.getElementById("loginPassword").value;
      const rememberMe =
        document.getElementById("rememberMe")?.checked || false;

      try {
        const response = await apiFetch("/login", {
          credentials: "include",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, rememberMe }),
        });

        const data = await parseApiResponse(response);

        if (response.ok) {
          // alert("Login successful!");
          Toast.show({
            message: "Login Sucessful",
            type: "success",
            duration: 2000,
          });
          // Auth pages should move you to the dashboard once logged in
          window.location.href = "/dashboard.html";
        } else {
          alert("Login failed: " + (data.error || "Unknown error"));
          Toast.show({
            message: "Login failed: " + (data.error || "Unknown error"),
            type: "error",
            duration: 4000,
          });
        }
      } catch (error) {
        console.error("Login request failed:", error);
        alert("Login failed due to a network/server issue.");
        Toast.show({
          message: "Login failed due to a network/server issue.",
          type: "error",
          duration: 2000,
        });
      }
    });
  }

  // Function to log out a user (dashboard only)
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (event) => {
      event.preventDefault();

      try {
        const response = await apiFetch("/logout", {
          credentials: "include",
          method: "POST",
        });

        if (response.ok) {
          Toast.show({
            message: "Logged out successfully",
            type: "success",
            duration: 2000,
          });
          // Send the user back to login after logout
          window.location.href = "/login.html";
        } else {
          const data = await parseApiResponse(response);
          alert("Logout failed: " + (data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("Logout request failed:", error);
        alert("Logout failed due to a network/server issue.");
      }
    });
  }

  // Task Submission Form
  // const submitBtn = document.getElementById("submitBtn");
  // if (submitBtn) {
  //     submitBtn.onclick = submit;
  // }
  const taskForm = document.getElementById("taskForm");
  if (taskForm) {
    taskForm.setAttribute("novalidate", "novalidate");
    taskForm.addEventListener("submit", submit);
  }

  const clearCompletedButton = document.getElementById(
    "clear-completed-tasks-btn",
  );
  if (clearCompletedButton) {
    clearCompletedButton.addEventListener("click", clearCompletedTasks);
  }

  bindDashboardTaskFilterTabs();
  initDailyEmailSettings();
  initDailyReflectionStatsWidget();
  initWeeklyReflectionStatsWidget();
  initFeedbackForm();

  checkAuthStatus({ isLoginPage, isRegisterPage, isProtectedPage, isHomePage }); // Check authentication status on page load
  initFocusMode();
});

async function updateNavTaskCounter() {
  const counters = document.querySelectorAll(".item-counter");
  if (!counters.length) return;

  try {
    const response = await apiFetch("/tasks", { credentials: "include" });
    if (!response.ok) return;

    const tasks = await response.json();
    const activeCount = Array.isArray(tasks)
      ? tasks.filter((task) => task.status === "active").length
      : 0;

    counters.forEach((el) => {
      el.textContent = String(activeCount);
    });
  } catch (error) {
    console.error("Error updating nav task counter:", error);
  }
}

// Function to check if a user is currently logged in
async function checkAuthStatus({
  isLoginPage = false,
  isRegisterPage = false,
  isProtectedPage = false,
  isHomePage = false,
} = {}) {
  const authSection = document.getElementById("auth-section");
  const mainSection = document.getElementById("main-section");
  const authStatus = document.getElementById("authStatus");
  const logoutBtn = document.getElementById("logoutBtn");

  let data = { loggedIn: false };

  try {
    const response = await apiFetch("/auth-status", {
      credentials: "include",
      cache: "no-store",
    });

    data = await parseApiResponse(response);
  } catch (error) {
    console.error("Auth status check failed:", error);
  }

  if (data.loggedIn) {
    if (isHomePage) {
      window.location.href = "/dashboard.html";
      return;
    }

    // Keep login/register pages from showing when already authenticated
    if (isLoginPage || isRegisterPage) {
      window.location.href = "/dashboard.html";
      return;
    }

    if (authStatus) {
      //Choose randomly from a set of welcome back messages

      // const messages = [
      //     "Ready when you are",
      //     "Time to tackle your tasks",
      //     "Ready to be productive",
      //     "Your tasks await",
      //     "Let's make today productive"
      // ];
      // const randomIndex = Math.floor(Math.random() * messages.length);
      // const welcomeMessage = messages[randomIndex];
      // authStatus.textContent += `${welcomeMessage} ${data.user.firstName}`;

      const rawName = String(
        data?.user?.firstName || data?.user?.name || "",
      ).trim();
      const firstName = rawName.split(/\s+/)[0] || "there";
      authStatus.textContent = `Welcome back, ${firstName}`;
    }
    authSection?.classList.add("hidden"); // Hide login/register CTA on dashboard
    mainSection?.classList.remove("hidden"); // Show main task page
    if (logoutBtn) {
      logoutBtn.style.display = "block";
    }
    if (mainSection) {
      fetchTasks(); // Automatically load tasks if user is logged in
    }
    updateFocusLogWidget();

    updateNavTaskCounter();
  } else {
    // Protected pages should send logged-out users to login instead of showing a blank shell.
    if (isProtectedPage) {
      window.location.href = "/login.html";
      return;
    }

    // Only toggle dashboard sections if they are present on the page
    if (authStatus) {
      authStatus.textContent = "Not logged in";
    }
    authSection?.classList.remove("hidden"); // Show login/register CTA
    mainSection?.classList.add("hidden"); // Hide main task page
    if (logoutBtn) {
      logoutBtn.style.display = "none";
    }
    const taskList = document.querySelector(".task-list");
    if (taskList) {
      taskList.innerHTML = ""; // Clear tasks when logged out
    }
  }
}

// Function to get the tasks for the logged in user
async function fetchTasks() {
  const response = await apiFetch("/tasks", { credentials: "include" });
  const tasks = await response.json();

  if (response.ok) {
    dashboardTaskState.allTasks = Array.isArray(tasks) ? tasks : [];
    updateTaskList(dashboardTaskState.allTasks);
  } else {
    console.error("Error fetching tasks:", tasks.error);
    alert("Please log in to see your tasks.");
  }
}

async function clearCompletedTasks() {
  const clearCompletedButton = document.getElementById(
    "clear-completed-tasks-btn",
  );

  if (clearCompletedButton) {
    clearCompletedButton.disabled = true;
  }

  try {
    const response = await apiFetch("/tasks", { credentials: "include" });
    const tasks = await parseApiResponse(response);

    if (!response.ok) {
      Toast.show({
        message: tasks?.error || "Could not load tasks.",
        type: "error",
        duration: 3000,
      });
      return;
    }

    const completedTasks = Array.isArray(tasks)
      ? tasks.filter((task) => task.status === "completed")
      : [];

    if (completedTasks.length === 0) {
      Toast.show({
        message: "No completed tasks to clear.",
        type: "error",
        duration: 2200,
      });
      return;
    }

    const deleteResults = await Promise.allSettled(
      completedTasks.map((task) =>
        apiFetch(`/tasks/${task._id}`, { method: "DELETE" }),
      ),
    );

    const deletedCount = deleteResults.filter(
      (result) => result.status === "fulfilled" && result.value.ok,
    ).length;

    if (deletedCount === completedTasks.length) {
      Toast.show({
        message: "Cleared completed tasks",
        type: "success",
        duration: 2500,
      });
    } else if (deletedCount > 0) {
      Toast.show({
        message: `Cleared ${deletedCount} completed tasks. Some could not be deleted.`,
        type: "error",
        duration: 3500,
      });
    } else {
      Toast.show({
        message: "Could not clear completed tasks.",
        type: "error",
        duration: 3000,
      });
    }

    fetchTasks();
  } catch (error) {
    console.error("Clearing completed tasks failed:", error);
    Toast.show({
      message: "Could not clear completed tasks.",
      type: "error",
      duration: 3000,
    });
  } finally {
    if (clearCompletedButton) {
      clearCompletedButton.disabled = false;
    }
  }
}

// Function to submit a task (User must be logged in)
const submit = async function (event) {
  event.preventDefault(); // Stop default form submission behavior

  const taskInput = document.querySelector("#taskDescription");
  const dateInput = document.querySelector("#dueDate");
  const effortInput = document.querySelector(
    'input[name="effortLevel"]:checked',
  );

  // Create JSON object with form data
  const dueDateValue = dateInput.value.trim();
  const json = {
    description: taskInput.value.trim(),
    dueDate: dueDateValue || null,
    effortLevel: effortInput ? parseInt(effortInput.value, 10) : 3,
  };

  if (!json.description) {
    Toast.show({
      message: "You should probably write down a task first!",
      type: "error",
      duration: 2500,
    });
    return;
  }

  try {
    // Send task data to the server
    const response = await apiFetch("/tasks", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });

    const data = await parseApiResponse(response);

    if (response.ok) {
      console.log("Task added successfully:", data);
      updateTaskList(data); // Refresh task list
      Toast.show({ message: "Task Submitted", type: "success", duration: 2000 });

      // Clear input fields after successful submission
      taskInput.value = "";
      dateInput.value = "";
      return;
    }

    console.error("Task Submission Error:", data?.error);
    Toast.show({
      message: data?.error || "Could not submit task.",
      type: "error",
      duration: 3000,
    });
  } catch (error) {
    console.error("Task submission failed:", error);
    Toast.show({
      message: "Could not submit task.",
      type: "error",
      duration: 3000,
    });
  }
};

function setBigThreeButtonState(button, isBigThree) {
  if (!button) return;

  const icon = button.querySelector("i");
  const active = Boolean(isBigThree);

  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? "Remove from Big 3" : "Add to Big 3";

  if (icon) {
    icon.classList.toggle("fa-solid", active);
    icon.classList.toggle("fa-regular", !active);
    icon.style.color = "rgba(237, 28, 28, 1.00)";
  }
}

function updateBigThreeWidget(tasks, taskInteractions = new Map()) {
  const bigThreeList = document.getElementById("big-three-list");
  const emptyState = document.querySelector("#big-3-tasks .big-three-empty");
  if (!bigThreeList || !emptyState) return;

  const bigThreeTasks = tasks.filter((task) => task.isBigThree).slice(0, 3);
  bigThreeList.innerHTML = "";

  if (bigThreeTasks.length === 0) {
    emptyState.hidden = false;
    bigThreeList.hidden = true;
    return;
  }

  emptyState.hidden = true;
  bigThreeList.hidden = false;

  bigThreeTasks.forEach((task, index) => {
    const item = document.createElement("li");
    item.className = "big-three-item";

    const interactions = taskInteractions.get(task._id) || {};

    const completeInput = document.createElement("input");
    completeInput.type = "checkbox";
    completeInput.className = "task-check big-three-check";
    completeInput.checked = task.status === "completed";
    completeInput.setAttribute("aria-label", `Mark task ${index + 1} complete`);

    if (typeof interactions.toggleComplete === "function") {
      completeInput.addEventListener("change", async () => {
        completeInput.disabled = true;
        const isCompleted = completeInput.checked;
        const updated = await interactions.toggleComplete(isCompleted);
        if (!updated) {
          completeInput.checked = !isCompleted;
        }
        completeInput.disabled = false;
      });
    } else {
      completeInput.disabled = true;
    }

    const descriptionButton = document.createElement("button");
    descriptionButton.type = "button";
    descriptionButton.className = "big-three-details-trigger";
    descriptionButton.textContent = `${index + 1}. ${task.description}`;
    descriptionButton.title = "Open task details";

    if (typeof interactions.openTaskDetails === "function") {
      descriptionButton.addEventListener("click", interactions.openTaskDetails);
    } else {
      descriptionButton.disabled = true;
    }

    item.append(completeInput, descriptionButton);
    bigThreeList.appendChild(item);
  });
}

let activeTaskInPanel = null;
let panelTypewriterRunId = 0;

function toDisplayDate(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const day = parseInt(match[3], 10);
      return new Date(year, month - 1, day, 12, 0, 0, 0);
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTaskDueDate(dueDate) {
  const date = toDisplayDate(dueDate);
  if (!date) return "No due date";
  return `Due: ${date.toLocaleDateString()}`;
}

function formatTaskEffortLevel(effortLevel) {
  const safeEffort = Math.max(1, Math.min(5, parseInt(effortLevel, 10) || 3));
  return `${safeEffort} / 5`;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function typeTextIntoElement(element, text, runId, speedMs = 20) {
  if (!element) return;

  const value = String(text || "");
  element.textContent = "";

  for (let index = 0; index < value.length; index += 1) {
    if (runId !== panelTypewriterRunId) return;
    element.textContent += value[index];
    await wait(speedMs);
  }
}

async function animateTaskDetailFields(task, runId) {
  const descriptionEl = document.getElementById("panelTaskDescription");
  const dueDateEl = document.getElementById("panelTaskDueDate");
  const effortEl = document.getElementById("panelTaskEffort");
  if (!descriptionEl || !dueDateEl || !effortEl) return;

  const descriptionText = task.description || "No description";
  const dueDateText = formatTaskDueDate(task.dueDate);
  const effortText = formatTaskEffortLevel(task.effortLevel);

  await typeTextIntoElement(descriptionEl, descriptionText, runId, 18);
  await typeTextIntoElement(dueDateEl, dueDateText, runId, 16);
  await typeTextIntoElement(effortEl, effortText, runId, 16);
}

function formatDateInputValue(dueDate) {
  if (!dueDate) return "";
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setPanelEffortInputValue(effortLevel) {
  const safeEffort = Math.max(1, Math.min(5, parseInt(effortLevel, 10) || 3));
  document
    .querySelectorAll('input[name="panelEffortLevel"]')
    .forEach((radio) => {
      radio.checked = parseInt(radio.value, 10) === safeEffort;
    });
}

function getPanelEffortInputValue() {
  const checked = document.querySelector(
    'input[name="panelEffortLevel"]:checked',
  );
  return checked ? parseInt(checked.value, 10) : 3;
}

function setTaskDetailEditMode(task, isEditing) {
  const panelEditButton = document.getElementById("panelEditBtn");
  const descriptionDisplay = document.getElementById("panelTaskDescription");
  const dueDateDisplay = document.getElementById("panelTaskDueDate");
  const effortDisplay = document.getElementById("panelTaskEffort");
  const descriptionInput = document.getElementById("panelTaskDescriptionInput");
  const dueDateInput = document.getElementById("panelTaskDueDateInput");
  const effortInput = document.getElementById("panelTaskEffortInput");

  if (
    !panelEditButton ||
    !descriptionDisplay ||
    !dueDateDisplay ||
    !effortDisplay ||
    !descriptionInput ||
    !dueDateInput ||
    !effortInput
  ) {
    return;
  }

  descriptionDisplay.hidden = isEditing;
  dueDateDisplay.hidden = isEditing;
  effortDisplay.hidden = isEditing;

  descriptionInput.hidden = !isEditing;
  dueDateInput.hidden = !isEditing;
  effortInput.hidden = !isEditing;

  const editLabel = panelEditButton.querySelector("span");
  const editIcon = panelEditButton.querySelector("i");
  if (editLabel) {
    editLabel.textContent = isEditing ? "Save" : "Edit";
  }
  if (editIcon) {
    editIcon.className = isEditing
      ? "fa-solid fa-floppy-disk"
      : "fa-solid fa-pen-to-square";
  }

  if (isEditing) {
    descriptionInput.value = task.description || "";
    dueDateInput.value = formatDateInputValue(task.dueDate);
    setPanelEffortInputValue(task.effortLevel);
    descriptionInput.focus();
  }
}

async function updateTaskCompletionStatus(
  task,
  isCompleted,
  taskCheck,
  taskItem,
  controls = {},
) {
  const nextStatus = isCompleted ? "completed" : "active";
  const shouldRemoveBigThree = isCompleted && Boolean(task.isBigThree);

  try {
    const payload = { status: nextStatus };
    if (shouldRemoveBigThree) {
      payload.isBigThree = false;
    }

    const updateResponse = await apiFetch(`/tasks/${task._id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!updateResponse.ok) {
      console.error("Error updating task status");
      return false;
    }

    task.status = nextStatus;

    if (shouldRemoveBigThree) {
      task.isBigThree = false;
      setBigThreeButtonState(controls.bigThreeButton, false);
      setBigThreeButtonState(controls.panelBigThreeButton, false);
    }

    if (taskCheck) {
      taskCheck.checked = isCompleted;
    }
    taskItem?.classList.toggle("is-completed", isCompleted);

    if (nextStatus === "completed") {
      Toast.show({
        message: "Task Completed! One step down, time for the next.",
        type: "success",
        duration: 4000,
      });
    }

    fetchTasks();
    return true;
  } catch (error) {
    console.error("Task status update failed:", error);
    return false;
  }
}

function closeTaskDetailPanel() {
  const panel = document.getElementById("task-detail-panel");
  const backdrop = document.getElementById("task-detail-backdrop");
  if (!panel || !backdrop) return;

  panel.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
  backdrop.classList.remove("is-visible");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.classList.remove("task-panel-open");

  const effortInput = document.getElementById("panelTaskEffortInput");
  if (effortInput) {
    effortInput.hidden = true;
  }

  const panelEditButton = document.getElementById("panelEditBtn");
  const editLabel = panelEditButton?.querySelector("span");
  const editIcon = panelEditButton?.querySelector("i");
  if (editLabel) editLabel.textContent = "Edit";
  if (editIcon) editIcon.className = "fa-solid fa-pen-to-square";

  panelTypewriterRunId += 1;
  activeTaskInPanel = null;
}

function wireTaskDetailPanel() {
  const panel = document.getElementById("task-detail-panel");
  const backdrop = document.getElementById("task-detail-backdrop");
  const closeButton = document.getElementById("taskDetailClose");
  if (!panel || !backdrop || !closeButton || panel.dataset.ready === "true")
    return;

  const panelBigThreeButton = document.getElementById("panelBigThreeBtn");
  const panelEditButton = document.getElementById("panelEditBtn");
  const panelDeleteButton = document.getElementById("panelDeleteBtn");
  const panelTaskComplete = document.getElementById("panelTaskComplete");

  closeButton.addEventListener("click", closeTaskDetailPanel);
  backdrop.addEventListener("click", closeTaskDetailPanel);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("is-open")) {
      closeTaskDetailPanel();
    }
  });

  panelBigThreeButton?.addEventListener("click", () =>
    activeTaskInPanel?.toggleBigThree?.(),
  );
  panelEditButton?.addEventListener("click", () =>
    activeTaskInPanel?.handleEditOrSave?.(),
  );
  panelDeleteButton?.addEventListener("click", () =>
    activeTaskInPanel?.deleteTask?.(),
  );
  panelTaskComplete?.addEventListener("change", () =>
    activeTaskInPanel?.toggleComplete?.(),
  );

  panel.dataset.ready = "true";
}

function openTaskDetailPanel(task, handlers) {
  const panel = document.getElementById("task-detail-panel");
  const backdrop = document.getElementById("task-detail-backdrop");
  const descriptionEl = document.getElementById("panelTaskDescription");
  const dueDateEl = document.getElementById("panelTaskDueDate");
  const effortEl = document.getElementById("panelTaskEffort");
  const panelBigThreeButton = document.getElementById("panelBigThreeBtn");
  const panelTaskComplete = document.getElementById("panelTaskComplete");
  const panelDescriptionInput = document.getElementById(
    "panelTaskDescriptionInput",
  );
  const panelDueDateInput = document.getElementById("panelTaskDueDateInput");
  const panelEffortInput = document.getElementById("panelTaskEffortInput");
  if (
    !panel ||
    !backdrop ||
    !descriptionEl ||
    !dueDateEl ||
    !effortEl ||
    !panelBigThreeButton ||
    !panelTaskComplete ||
    !panelDescriptionInput ||
    !panelDueDateInput ||
    !panelEffortInput
  )
    return;

  wireTaskDetailPanel();

  panelTypewriterRunId += 1;
  const currentRunId = panelTypewriterRunId;
  descriptionEl.textContent = "";
  dueDateEl.textContent = "";
  effortEl.textContent = "";
  animateTaskDetailFields(task, currentRunId);

  setBigThreeButtonState(panelBigThreeButton, task.isBigThree);
  panelBigThreeButton.disabled = false;
  panelTaskComplete.checked = task.status === "completed";

  let isEditing = false;
  setTaskDetailEditMode(task, false);

  activeTaskInPanel = {
    ...handlers,
    syncBigThree(nextValue) {
      task.isBigThree = nextValue;
      setBigThreeButtonState(panelBigThreeButton, nextValue);
    },
    syncCompletion(nextStatus) {
      task.status = nextStatus;
      panelTaskComplete.checked = nextStatus === "completed";
    },
    async handleEditOrSave() {
      if (!isEditing) {
        isEditing = true;
        setTaskDetailEditMode(task, true);
        return;
      }

      const nextDescription = panelDescriptionInput.value.trim();
      const nextDueDate = panelDueDateInput.value || null;
      const nextEffortLevel = getPanelEffortInputValue();

      if (!nextDescription) {
        Toast.show({
          message: "Task description cannot be empty.",
          type: "error",
          duration: 3000,
        });
        return;
      }

      const savedTask = await handlers.saveTaskEdits?.({
        description: nextDescription,
        dueDate: nextDueDate,
        effortLevel: nextEffortLevel,
      });

      if (!savedTask) return;

      task.description = savedTask.description ?? nextDescription;
      task.dueDate = savedTask.dueDate ?? nextDueDate;
      task.effortLevel = savedTask.effortLevel ?? nextEffortLevel;

      isEditing = false;
      setTaskDetailEditMode(task, false);

      panelTypewriterRunId += 1;
      const updatedRunId = panelTypewriterRunId;
      descriptionEl.textContent = "";
      dueDateEl.textContent = "";
      effortEl.textContent = "";
      animateTaskDetailFields(task, updatedRunId);
    },
  };

  panel.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
  backdrop.classList.add("is-visible");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("task-panel-open");
}

function getTaskDueSortTimestamp(dueDate) {
  if (!dueDate) return Number.POSITIVE_INFINITY;
  const parsedDate = new Date(dueDate);
  if (Number.isNaN(parsedDate.getTime())) return Number.POSITIVE_INFINITY;
  return parsedDate.getTime();
}

function getDashboardTasksByFilter(tasks, filter = "task-list") {
  const safeTasks = Array.isArray(tasks) ? tasks.slice() : [];

  return safeTasks.sort((a, b) => {
    const aCompleted = a.status === "completed";
    const bCompleted = b.status === "completed";

    if (aCompleted !== bCompleted) {
      return aCompleted ? 1 : -1;
    }

    if (filter === "effort") {
      const effortA = Number(a?.effortLevel) || 5;
      const effortB = Number(b?.effortLevel) || 5;
      if (effortA !== effortB) return effortA - effortB;
    } else if (filter === "due-date") {
      const dueA = getTaskDueSortTimestamp(a?.dueDate);
      const dueB = getTaskDueSortTimestamp(b?.dueDate);
      if (dueA !== dueB) return dueA - dueB;
    }

    const aCreated = new Date(a?.createdAt || 0).getTime();
    const bCreated = new Date(b?.createdAt || 0).getTime();
    return bCreated - aCreated;
  });
}

function updateDashboardTaskFilterTabs(selectedFilter) {
  const tabButtons = document.querySelectorAll(".task-list-tab");
  if (!tabButtons.length) return;

  tabButtons.forEach((buttonEl) => {
    const isActive = buttonEl.dataset.filter === selectedFilter;
    buttonEl.classList.toggle("is-active", isActive);
    buttonEl.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function bindDashboardTaskFilterTabs() {
  const tabButtons = document.querySelectorAll(".task-list-tab");
  if (!tabButtons.length) return;

  tabButtons.forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      const filter = buttonEl.dataset.filter || "task-list";
      if (filter === dashboardTaskState.filter) return;

      dashboardTaskState.filter = filter;
      updateTaskList(dashboardTaskState.allTasks);
    });
  });

  updateDashboardTaskFilterTabs(dashboardTaskState.filter);
}

// Function to update the UI with fetched tasks
function updateTaskList(tasks) {
  const listOfTasks = document.querySelector(".task-list");
  const taskTemplate = document.querySelector("#task-template");
  const bigThreeInteractions = new Map();
  tasks = Array.isArray(tasks) ? tasks : [];
  dashboardTaskState.allTasks = tasks;

  const baseSortedTasks = getDashboardTasksByFilter(tasks, "task-list");
  const sortedTasks = getDashboardTasksByFilter(
    tasks,
    dashboardTaskState.filter,
  );

  if (!listOfTasks) {
    return; // Avoid errors on pages without the dashboard
  }
  if (!taskTemplate) {
    console.error("Task template not found in DOM");
    return;
  }

  listOfTasks.innerHTML = ""; // Clear existing task list

  sortedTasks.forEach((task) => {
    const clone = taskTemplate.content.cloneNode(true);
    const taskItem = clone.querySelector(".task-item");
    const taskText = clone.querySelector(".task-text");
    const taskDetailsTrigger = clone.querySelector(".task-details-trigger");
    const taskCheck = clone.querySelector(".task-check");
    const dueText = clone.querySelector(".task-due");
    const effortDots = clone.querySelectorAll(".task-effort .dot");
    const bigThreeIndicator = clone.querySelector(".task-big-three-indicator");
    const bigThreeButton = clone.querySelector(".big-three-btn");
    const panelBigThreeButton = document.getElementById("panelBigThreeBtn");

    if (taskItem && taskText) {
      taskText.textContent = task.description;
      taskText.title = "Open task details";
    }
    const setTaskCompletion = async (isCompleted) => {
      const updated = await updateTaskCompletionStatus(
        task,
        isCompleted,
        taskCheck,
        taskItem,
        {
          bigThreeButton,
          panelBigThreeButton,
        },
      );

      if (updated && activeTaskInPanel) {
        activeTaskInPanel.syncCompletion(task.status);
        activeTaskInPanel.syncBigThree(Boolean(task.isBigThree));
      }

      return updated;
    };

    if (taskCheck) {
      taskCheck.checked = task.status === "completed";
      taskItem?.classList.toggle("is-completed", taskCheck.checked);

      taskCheck.addEventListener("change", async () => {
        const isCompleted = taskCheck.checked;
        const updated = await setTaskCompletion(isCompleted);

        if (!updated) {
          taskCheck.checked = !isCompleted;
          taskItem?.classList.toggle("is-completed", taskCheck.checked);
        }

        // If the task was just completed and it's currently focused, end the focus session since the task is no longer active
        if (
          updated &&
          isCompleted &&
          focusState.taskId &&
          String(focusState.taskId) === String(task._id)
        ) {
          await stopFocusSession("completed_task");
        }
      });
    }

    if (dueText) {
      if (task.dueDate) {
        dueText.textContent = formatTaskDueDate(task.dueDate);
        dueText.hidden = false;
      } else {
        dueText.textContent = "";
        dueText.hidden = true;
      }
    }
    if (effortDots.length > 0) {
      const effortLevel = Math.max(
        1,
        Math.min(5, parseInt(task.effortLevel, 10) || 3),
      );
      effortDots.forEach((dot, index) => {
        dot.classList.toggle("on", index < effortLevel);
      });
    }
    if (bigThreeIndicator) {
      bigThreeIndicator.hidden = !task.isBigThree;
      bigThreeIndicator.title = task.isBigThree ? "In Big 3" : "";
    }
    setBigThreeButtonState(bigThreeButton, task.isBigThree);

    const toggleBigThree = async () => {
      if (task.status === "completed") {
        Toast.show({
          message: "Completed tasks can't be added to Big 3.",
          type: "error",
          duration: 3200,
        });
        return;
      }

      const nextIsBigThree = !task.isBigThree;
      if (bigThreeButton) bigThreeButton.disabled = true;

      try {
        const updateResponse = await apiFetch(`/tasks/${task._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isBigThree: nextIsBigThree }),
        });

        const updatedTask = await parseApiResponse(updateResponse);
        if (updateResponse.ok) {
          task.isBigThree = Boolean(updatedTask.isBigThree);
          setBigThreeButtonState(bigThreeButton, task.isBigThree);
          if (task.isBigThree) {
            Toast.show({
              message: "Task added to your Big 3",
              type: "success",
              duration: 2200,
            });
          }
          fetchTasks();
        } else {
          Toast.show({
            message: updatedTask.error || "Could not update Big 3 status.",
            type: "error",
            duration: 3500,
          });
          setBigThreeButtonState(bigThreeButton, task.isBigThree);
        }
      } catch (error) {
        console.error("Task Big 3 toggle failed:", error);
        Toast.show({
          message: "Could not update Big 3 status.",
          type: "error",
          duration: 3000,
        });
        setBigThreeButtonState(bigThreeButton, task.isBigThree);
      } finally {
        if (bigThreeButton) bigThreeButton.disabled = false;
      }
    };

    bigThreeButton?.addEventListener("click", toggleBigThree);

    const saveTaskEdits = async (updates) => {
      const updateResponse = await apiFetch(`/tasks/${task._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      const updateData = await parseApiResponse(updateResponse);
      if (updateResponse.ok) {
        Toast.show({
          message: "Task Updated",
          type: "success",
          duration: 2000,
        });
        fetchTasks();
        return updateData;
      }

      Toast.show({
        message: updateData.error || "Error updating task",
        type: "error",
        duration: 3200,
      });
      return null;
    };

    // Add event listener for deleting a task
    const deleteTask = async () => {
      const confirmDelete = confirm(
        "Are you sure you want to delete this task?",
      );
      if (confirmDelete) {
        const deleteResponse = await apiFetch(`/tasks/${task._id}`, {
          method: "DELETE",
        });

        if (deleteResponse.ok) {
          console.log("Task deleted successfully");
          Toast.show({
            message: "Task deleted",
            type: "success",
            duration: 2000,
          });
          fetchTasks(); // Refresh task list after deletion
        } else {
          console.error("Error deleting task");
        }
      }
    };

    const rowDeleteButton = clone.querySelector(".delete-btn");

    rowDeleteButton?.addEventListener("click", deleteTask);

    const openTaskDetails = () => {
      openTaskDetailPanel(task, {
        toggleBigThree: async () => {
          panelBigThreeButton.disabled = true;
          await toggleBigThree();
          if (activeTaskInPanel) {
            activeTaskInPanel.syncBigThree(Boolean(task.isBigThree));
          }
          panelBigThreeButton.disabled = false;
        },
        saveTaskEdits,
        deleteTask: async () => {
          await deleteTask();
          closeTaskDetailPanel();
        },
        toggleComplete: async () => {
          const panelTaskComplete =
            document.getElementById("panelTaskComplete");
          if (!panelTaskComplete) return;

          panelTaskComplete.disabled = true;
          const isCompleted = panelTaskComplete.checked;
          const updated = await setTaskCompletion(isCompleted);

          if (!updated) {
            panelTaskComplete.checked = !isCompleted;
          }

          panelTaskComplete.disabled = false;
        },
      });
    };

    taskDetailsTrigger?.addEventListener("click", openTaskDetails);
    if (task?._id) {
      bigThreeInteractions.set(task._id, {
        openTaskDetails,
        toggleComplete: setTaskCompletion,
      });
    }

    listOfTasks.appendChild(clone);
  });

  updateFocusTaskOptions(baseSortedTasks);
  updateBigThreeWidget(baseSortedTasks, bigThreeInteractions);

  // Update the task counter
  document.querySelectorAll(".item-counter").forEach((el) => {
    const activeCount = Array.isArray(tasks)
      ? tasks.filter((t) => t.status === "active").length
      : 0;

    el.textContent = String(activeCount);
  });

  updateDashboardTaskFilterTabs(dashboardTaskState.filter);

  const clearCompletedButton = document.getElementById(
    "clear-completed-tasks-btn",
  );
  if (clearCompletedButton) {
    const hasCompletedTasks =
      Array.isArray(tasks) && tasks.some((task) => task.status === "completed");
    clearCompletedButton.disabled = !hasCompletedTasks;
  }

  // If no tasks, show a friendly message
  if (sortedTasks.length === 0) {
    listOfTasks.innerHTML =
      "<p>No tasks found. Add a new task to get started!</p>";
  }
}

// Only enable periodic refresh on pages that actually have the dashboard
const hasDashboard = document.getElementById("main-section");

if (hasDashboard) {
  const REFRESH_MS = 30000;

  function refreshDashboard() {
    checkAuthStatus();
  }

  setInterval(refreshDashboard, REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshDashboard();
    }
  });
}

// ----------------------------
// Responsive Nav (drawer + view select)
// ----------------------------
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".nav__toggle");
  const drawer = document.getElementById("nav-drawer");
  const backdrop = document.getElementById("nav-backdrop");
  const compactNav = window.matchMedia(
    "(max-width: 1023px), (hover: none) and (pointer: coarse)",
  );

  if (toggle && drawer && backdrop) {
    const openDrawer = () => {
      closeTaskDetailPanel();
      drawer.classList.add("is-open");
      backdrop.classList.add("is-visible");
      toggle.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
    };

    const closeDrawer = () => {
      drawer.classList.remove("is-open");
      backdrop.classList.remove("is-visible");
      toggle.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    };

    toggle.addEventListener("click", () => {
      if (!compactNav.matches) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      expanded ? closeDrawer() : openDrawer();
    });

    backdrop.addEventListener("click", closeDrawer);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawer.classList.contains("is-open"))
        closeDrawer();
    });

    drawer.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", closeDrawer);
    });

    compactNav.addEventListener("change", (event) => {
      if (!event.matches) {
        closeDrawer();
      }
    });
  }
});

// ----------------------------
// Mobile/tablet sticky-note center activation
// ----------------------------
document.addEventListener("DOMContentLoaded", () => {
  const compactView = window.matchMedia(
    "(max-width: 1023px), (hover: none) and (pointer: coarse)",
  );
  const stickyNotes = Array.from(
    document.querySelectorAll(".corkboard .sticky-note"),
  );
  if (stickyNotes.length === 0) return;

  let rafId = null;

  const clearActiveNotes = () => {
    stickyNotes.forEach((note) => note.classList.remove("in-view-hover"));
  };

  const updateStickyNoteStates = () => {
    rafId = null;

    if (!compactView.matches) {
      clearActiveNotes();
      return;
    }

    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const centerY = viewportHeight * 0.5;
    const activeHalfBand = viewportHeight * 0.18; // ~36% total active zone around center
    const upperBound = centerY - activeHalfBand;
    const lowerBound = centerY + activeHalfBand;

    stickyNotes.forEach((note) => {
      const rect = note.getBoundingClientRect();
      const noteCenter = rect.top + rect.height / 2;
      const isVisible = rect.bottom > 0 && rect.top < viewportHeight;
      const inCenterBand = noteCenter >= upperBound && noteCenter <= lowerBound;

      note.classList.toggle("in-view-hover", isVisible && inCenterBand);
    });
  };

  const requestUpdate = () => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(updateStickyNoteStates);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate, { passive: true });
  compactView.addEventListener("change", requestUpdate);

  updateStickyNoteStates();
});
