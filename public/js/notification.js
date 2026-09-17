/* =========================================================
   TOAST SYSTEM (Single Component + Queue)
   Usage: Toast.show({ message, type, title, duration })
   ========================================================= */

const Toast = (() => {
  const el = document.getElementById("toast");
  const msgEl = document.getElementById("toastMessage");
  const titleEl = document.getElementById("toastTitle");
  const iconEl = el?.querySelector(".toast__icon");
  const closeBtn = document.getElementById("toastClose");
  const progressEl = el?.querySelector(".toast__progress::before"); // not directly selectable

  if (!el || !msgEl || !closeBtn || !iconEl) {
    console.warn("Toast system: missing required DOM elements.");
    return { show: () => {} };
  }

  // Queue so toasts don't overlap
  const queue = [];
  let isShowing = false;
  let hideTimer = null;

  const ICONS = {
    default: "?",
    success: "✅",
    error: "⚠️",
    warning: "?",
    info: "ℹ️",
  };

  function setType(type) {
    const t = (type || "default").toLowerCase();
    el.classList.remove("toast--default", "toast--success", "toast--error", "toast--warning", "toast--info");
    el.classList.add(`toast--${ICONS[t] ? t : "default"}`);
    iconEl.textContent = ICONS[t] || ICONS.default;

    // For screen readers, errors should be more assertive.
    el.setAttribute("aria-live", t === "error" ? "assertive" : "polite");
  }

  function setProgress(durationMs) {
    const bar = el.querySelector(".toast__progress");
    if (!bar) return;

    // Reset transition by forcing reflow
    bar.style.display = durationMs ? "block" : "none";
    const before = bar; // we'll animate ::before via CSS variable trick below

    // Animate ::before using a CSS custom property on the parent:
    // (We switch from scaleX(1) to scaleX(0) with transition duration)
    bar.style.setProperty("--toast-progress-duration", `${durationMs}ms`);

    // Use inline style hook: set transition duration on ::before by toggling a class.
    // Simpler: just set it directly on the bar and use CSS to read it.
    // We'll do it by updating the stylesheet behavior via style attribute:
    const styleId = "toast-progress-style";
    let styleTag = document.getElementById(styleId);
    if (!styleTag) {
      styleTag = document.createElement("style");
      styleTag.id = styleId;
      document.head.appendChild(styleTag);
    }

    styleTag.textContent = `
      #toast .toast__progress::before { transition-duration: ${durationMs}ms; }
    `;

    // Reset to full, then animate to empty
    bar.classList.remove("toast__progress--run");
    void bar.offsetWidth; // reflow
    bar.classList.add("toast__progress--run");

    // The actual transform change is triggered by class (see below)
  }

  // Add the class-driven transform behavior
  (function ensureProgressCSS() {
    const styleId = "toast-progress-run-css";
    if (document.getElementById(styleId)) return;
    const styleTag = document.createElement("style");
    styleTag.id = styleId;
    styleTag.textContent = `
      #toast .toast__progress--run::before { transform: scaleX(0); }
    `;
    document.head.appendChild(styleTag);
  })();

  function showNext() {
    if (isShowing || queue.length === 0) return;

    isShowing = true;
    const { message, type = "default", title = "", duration = 3000 } = queue.shift();

    setType(type);

    if (title) {
      titleEl.hidden = false;
      titleEl.textContent = title;
    } else {
      titleEl.hidden = true;
      titleEl.textContent = "";
    }

    msgEl.textContent = message ?? "";

    // Show
    el.hidden = false;
    el.classList.remove("toast--hide");
    el.classList.add("toast--show");

    // Progress + auto hide (duration 0 => sticky until close)
    clearTimeout(hideTimer);

    if (duration && duration > 0) {
      setProgress(duration);

      hideTimer = setTimeout(() => {
        hide();
      }, duration);
    } else {
      // No auto-dismiss
      const bar = el.querySelector(".toast__progress");
      if (bar) bar.style.display = "none";
    }
  }

  function hide() {
    clearTimeout(hideTimer);

    el.classList.remove("toast--show");
    el.classList.add("toast--hide");

    // Wait for animation then fully hide and show next queued toast
    const done = () => {
      el.hidden = true;
      el.classList.remove("toast--hide");
      el.removeEventListener("animationend", done);

      isShowing = false;
      showNext();
    };

    // If reduced motion (or animation doesn't fire), fail-safe timeout
    el.addEventListener("animationend", done);
    setTimeout(done, 200);
  }

  closeBtn.addEventListener("click", hide);

  // Public API
  function show(opts) {
    queue.push({
      message: opts?.message ?? "",
      type: opts?.type ?? "default",
      title: opts?.title ?? "",
      duration: Number.isFinite(opts?.duration) ? opts.duration : 3000,
    });
    showNext();
  }

  return { show, hide };
})();

