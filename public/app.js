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

  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
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

    function applyState() {
      window.scrollTo({
        left: 0,
        top: Number(state.windowY) || 0,
        behavior: "auto",
      });
      document.querySelectorAll("[data-scroll-panel]").forEach((panel) => {
        const name = panel.dataset.scrollPanel;
        if (state.panels && Object.prototype.hasOwnProperty.call(state.panels, name)) {
          panel.scrollTop = Number(state.panels[name]) || 0;
        }
      });
    }

    requestAnimationFrame(() => {
      applyState();
      window.setTimeout(applyState, 80);
      window.setTimeout(applyState, 220);
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

  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button[type='submit'], button[formaction]");
      if (button && scopeRoot.contains(button)) {
        writeState();
      }
    },
    true
  );

  window.addEventListener("beforeunload", writeState);
  if (window.location.hash) {
    requestAnimationFrame(() => {
      const targetId = decodeURIComponent(window.location.hash.slice(1));
      const target = document.getElementById(targetId);
      if (!target) {
        return;
      }
      if (target.tagName === "DETAILS") {
        target.open = true;
      }
      target.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    });
    return;
  }
  restoreState();
})();

(function calculatorSubmitFlow() {
  const forms = [...document.querySelectorAll("[data-calculator-form]")];
  let resultsPanel = document.querySelector("[data-calculator-results]");
  const breakdownSlot = document.querySelector("[data-calculator-breakdown-slot]");
  if (!forms.length) {
    return;
  }

  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }

  const storageKey = `expressline-calculator:${window.location.pathname}`;
  const maxAgeMs = 2 * 60 * 1000;

  function saveState(options = {}) {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          path: window.location.pathname,
          focusResult: Boolean(options.focusResult),
          time: Date.now(),
          windowY: window.scrollY,
        })
      );
    } catch (_error) {
      // A missing scroll restore is better than blocking the quote flow.
    }
  }

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || "null");
    } catch (_error) {
      return null;
    }
  }

  function clearState() {
    try {
      sessionStorage.removeItem(storageKey);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function resultIsVisible(panel) {
    const rect = panel.getBoundingClientRect();
    const topGuard = 72;
    return rect.top >= topGuard && rect.top < window.innerHeight * 0.78;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getResultsPanel() {
    resultsPanel = document.querySelector("[data-calculator-results]");
    return resultsPanel;
  }

  function showLoadingState(panel) {
    if (!panel) {
      return;
    }

    const title = panel.dataset.loadingTitle || "Calculating";
    const description =
      panel.dataset.loadingDescription || "Updating the quote result.";
    panel.dataset.hasResult = "loading";
    panel.setAttribute("aria-busy", "true");
    panel.classList.add("is-loading");
    panel.innerHTML = `
      <div class="loading-state" role="status" aria-live="polite">
        <span class="loading-spinner" aria-hidden="true"></span>
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
      </div>
    `;
  }

  function setSubmitState(form, submitter, isSubmitting) {
    form.classList.toggle("is-submitting", isSubmitting);
    form.setAttribute("aria-busy", isSubmitting ? "true" : "false");

    if (submitter) {
      submitter.disabled = isSubmitting;
    }
  }

  function buildRequestBody(form, submitter) {
    const formData = new FormData(form);
    if (submitter?.name) {
      formData.append(submitter.name, submitter.value);
    }
    return new URLSearchParams(formData);
  }

  function replaceBreakdown(nextDocument) {
    if (!breakdownSlot) {
      return;
    }

    const nextSlot = nextDocument.querySelector("[data-calculator-breakdown-slot]");
    breakdownSlot.innerHTML = nextSlot ? nextSlot.innerHTML : "";
  }

  function waitForMinimumLoading(startTime) {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 180 - elapsed);
    return new Promise((resolve) => {
      window.setTimeout(resolve, remaining);
    });
  }

  async function submitCalculator(form, submitter) {
    const panel = getResultsPanel();
    if (!panel || !window.fetch || !window.DOMParser || !window.URLSearchParams) {
      return false;
    }

    const loadingStartedAt = Date.now();
    showLoadingState(panel);
    if (breakdownSlot) {
      breakdownSlot.innerHTML = "";
    }
    setSubmitState(form, submitter, true);

    try {
      const response = await fetch(submitter?.formAction || form.action, {
        method: (submitter?.formMethod || form.method || "post").toUpperCase(),
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: buildRequestBody(form, submitter),
      });
      const html = await response.text();
      await waitForMinimumLoading(loadingStartedAt);
      const nextDocument = new DOMParser().parseFromString(html, "text/html");
      const nextPanel = nextDocument.querySelector("[data-calculator-results]");

      if (!nextPanel) {
        if (response.redirected && response.url) {
          window.location.assign(response.url);
          return true;
        }
        throw new Error("Missing calculator results panel.");
      }

      panel.replaceWith(nextPanel);
      resultsPanel = nextPanel;
      replaceBreakdown(nextDocument);
      nextPanel.classList.add("result-just-updated");
      nextPanel.removeAttribute("aria-busy");
      window.setTimeout(() => {
        nextPanel.classList.remove("result-just-updated");
      }, 1000);
      clearState();
    } catch (_error) {
      const currentPanel = getResultsPanel();
      if (currentPanel) {
        const title = currentPanel.dataset.errorTitle || "Calculation failed";
        const description =
          currentPanel.dataset.errorDescription ||
          "Please check the input and calculate again.";
        currentPanel.classList.remove("is-loading");
        currentPanel.removeAttribute("aria-busy");
        currentPanel.innerHTML = `
          <div class="empty-state">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>
        `;
      }
    } finally {
      setSubmitState(form, submitter, false);
    }

    return true;
  }

  function restoreAfterSubmit() {
    const state = readState();
    if (
      !state ||
      state.path !== window.location.pathname ||
      Date.now() - state.time > maxAgeMs
    ) {
      return;
    }

    clearState();
    requestAnimationFrame(() => {
      window.scrollTo({
        left: 0,
        top: Number(state.windowY) || 0,
        behavior: "auto",
      });

      if (
        state.focusResult &&
        resultsPanel &&
        resultsPanel.dataset.hasResult === "true"
      ) {
        window.setTimeout(() => {
          resultsPanel.classList.add("result-just-updated");
          if (!resultIsVisible(resultsPanel)) {
            resultsPanel.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          }
          window.setTimeout(() => {
            resultsPanel.classList.remove("result-just-updated");
          }, 1000);
        }, 90);
      }
    });
  }

  forms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      const submitter = event.submitter;
      const focusResult = Boolean(submitter?.matches("[data-calculate-submit]"));
      saveState({ focusResult });

      if (focusResult) {
        event.preventDefault();
        submitCalculator(form, submitter).then((handled) => {
          if (!handled) {
            form.submit();
          }
        });
      }
    });
  });

  restoreAfterSubmit();
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

(function fieldHelpTooltips() {
  const helpNodes = [...document.querySelectorAll(".field-help[title]")];
  if (!helpNodes.length) {
    return;
  }

  const popover = document.createElement("div");
  popover.className = "help-popover";
  popover.id = "help-popover";
  popover.setAttribute("role", "tooltip");
  popover.hidden = true;
  document.body.appendChild(popover);

  let activeNode = null;

  function placePopover(node) {
    const rect = node.getBoundingClientRect();
    const margin = 12;
    const maxLeft = window.innerWidth - popover.offsetWidth - margin;
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    const belowTop = rect.bottom + 8;
    const aboveTop = rect.top - popover.offsetHeight - 8;
    const top =
      belowTop + popover.offsetHeight < window.innerHeight
        ? belowTop
        : Math.max(margin, aboveTop);

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function showPopover(node) {
    activeNode = node;
    popover.textContent = node.dataset.help || "";
    popover.hidden = false;
    placePopover(node);
  }

  function hidePopover() {
    activeNode = null;
    popover.hidden = true;
  }

  helpNodes.forEach((node) => {
    node.dataset.help = node.getAttribute("title") || "";
    node.removeAttribute("title");
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", node.dataset.help);
    node.setAttribute("aria-describedby", "help-popover");

    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeNode === node && !popover.hidden) {
        hidePopover();
      } else {
        showPopover(node);
      }
    });

    node.addEventListener("mouseenter", () => showPopover(node));
    node.addEventListener("focus", () => showPopover(node));
    node.addEventListener("mouseleave", hidePopover);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePopover();
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showPopover(node);
      }
    });
  });

  document.addEventListener("click", (event) => {
    if (
      activeNode &&
      !event.target.closest(".field-help") &&
      !event.target.closest(".help-popover")
    ) {
      hidePopover();
    }
  });

  window.addEventListener("scroll", () => {
    if (activeNode && !popover.hidden) {
      placePopover(activeNode);
    }
  }, true);
  window.addEventListener("resize", hidePopover);
})();

(function consistentNumberInputs() {
  const selector = "input[type='number']:not([readonly]):not([disabled])";

  function selectInput(input) {
    window.setTimeout(() => {
      try {
        input.select();
      } catch (_error) {
        input.setSelectionRange?.(0, String(input.value || "").length);
      }
    }, 0);
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      const input = event.target.closest(selector);
      if (!input || document.activeElement === input) {
        return;
      }

      event.preventDefault();
      try {
        input.focus({ preventScroll: true });
      } catch (_error) {
        input.focus();
      }
      selectInput(input);
    },
    true
  );

  document.addEventListener("focusin", (event) => {
    const input = event.target.closest(selector);
    if (input) {
      selectInput(input);
    }
  });
})();
