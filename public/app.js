(function preferences() {
  const root = document.documentElement;
  const button = document.querySelector("[data-theme-toggle]");
  const storageKey = "expressline-theme";

  function getStoredTheme() {
    try {
      return localStorage.getItem(storageKey) === "light" ? "light" : "dark";
    } catch (_error) {
      return "dark";
    }
  }

  function setTheme(theme) {
    const safeTheme = theme === "light" ? "light" : "dark";
    root.dataset.theme = safeTheme;

    try {
      localStorage.setItem(storageKey, safeTheme);
    } catch (_error) {
      // Local storage can be unavailable in locked-down browser contexts.
    }

    if (button) {
      button.setAttribute("aria-pressed", safeTheme === "dark" ? "true" : "false");
      button.dataset.themeValue = safeTheme;
    }
  }

  setTheme(getStoredTheme());

  if (button) {
    button.addEventListener("click", () => {
      setTheme(root.dataset.theme === "light" ? "dark" : "light");
    });
  }
})();

(function preserveAdminScroll() {
  const scopeRoot = document.querySelector("[data-scroll-scope]");
  if (!scopeRoot) {
    return;
  }

  const scope = scopeRoot.dataset.scrollScope || "page";
  const storageKey = `expressline-scroll:${scope}`;
  const maxAgeMs = 30 * 60 * 1000;

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || "null");
    } catch (_error) {
      return null;
    }
  }

  function writeState() {
    const panels = {};
    document.querySelectorAll("[data-scroll-panel]").forEach((panel) => {
      panels[panel.dataset.scrollPanel] = panel.scrollTop;
    });

    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          path: window.location.pathname,
          time: Date.now(),
          windowY: window.scrollY,
          panels,
        })
      );
    } catch (_error) {
      // Losing scroll restoration is acceptable if storage is unavailable.
    }
  }

  function restoreState() {
    const state = readState();
    if (!state || Date.now() - state.time > maxAgeMs) {
      return;
    }

    requestAnimationFrame(() => {
      window.scrollTo(0, Number(state.windowY) || 0);
      document.querySelectorAll("[data-scroll-panel]").forEach((panel) => {
        const name = panel.dataset.scrollPanel;
        if (state.panels && Object.prototype.hasOwnProperty.call(state.panels, name)) {
          panel.scrollTop = Number(state.panels[name]) || 0;
        }
      });
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest("a[href]");
      if (!link || !scopeRoot.contains(link)) {
        return;
      }

      const nextUrl = new URL(link.href, window.location.href);
      if (nextUrl.origin === window.location.origin) {
        writeState();
      }
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (scopeRoot.contains(event.target)) {
        writeState();
      }
    },
    true
  );

  window.addEventListener("beforeunload", writeState);
  restoreState();
})();
