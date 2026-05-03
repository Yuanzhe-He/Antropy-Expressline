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

(function adminFormSafeguards() {
  const forms = [...document.querySelectorAll("[data-admin-form]")];
  if (!forms.length) {
    return;
  }

  let hasPendingChanges = false;
  let allowNavigation = false;

  function setFormState(form, dirty) {
    form.dataset.dirty = dirty ? "true" : "false";
    const stateLabel = form.querySelector("[data-save-state]");
    if (stateLabel) {
      stateLabel.textContent = dirty
        ? form.dataset.unsavedLabel || "Unsaved changes"
        : form.dataset.savedLabel || "No pending changes";
    }
    const discardButton = form.querySelector("[data-discard-changes]");
    if (discardButton) {
      discardButton.disabled = !dirty;
    }
  }

  forms.forEach((form) => {
    setFormState(form, false);

    form.addEventListener("input", () => {
      hasPendingChanges = true;
      setFormState(form, true);
    });

    form.addEventListener("change", () => {
      hasPendingChanges = true;
      setFormState(form, true);
    });

    form.addEventListener("submit", (event) => {
      const submitter = event.submitter;
      const confirmMessage = submitter?.dataset.confirmSubmit;
      if (confirmMessage && !window.confirm(confirmMessage)) {
        event.preventDefault();
        return;
      }
      allowNavigation = true;
    });

    const discardButton = form.querySelector("[data-discard-changes]");
    if (discardButton) {
      discardButton.addEventListener("click", () => {
        allowNavigation = true;
        window.location.reload();
      });
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest("a[href]");
      if (!link || allowNavigation || !hasPendingChanges) {
        return;
      }

      const nextUrl = new URL(link.href, window.location.href);
      if (nextUrl.origin === window.location.origin) {
        const message =
          forms[0]?.dataset.confirmLeave || "You have unsaved changes. Leave?";
        if (!window.confirm(message)) {
          event.preventDefault();
        } else {
          allowNavigation = true;
        }
      }
    },
    true
  );

  window.addEventListener("beforeunload", (event) => {
    if (!hasPendingChanges || allowNavigation) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });
})();

(function adminListFilter() {
  const input = document.querySelector("[data-admin-filter]");
  const linksRoot = document.querySelector("[data-admin-filter-list]");
  if (!input || !linksRoot) {
    return;
  }

  const links = [...linksRoot.querySelectorAll("[data-admin-filter-item]")];
  const emptyState = document.querySelector("[data-admin-filter-empty]");

  function applyFilter() {
    const query = input.value.trim().toLowerCase();
    let visibleCount = 0;

    links.forEach((link) => {
      const haystack = link.textContent.trim().toLowerCase();
      const visible = !query || haystack.includes(query);
      link.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    });

    if (emptyState) {
      emptyState.hidden = visibleCount > 0;
    }
  }

  input.addEventListener("input", applyFilter);
  applyFilter();
})();
