import "./styles.css";
import {
  clearSession,
  loadSession,
  parseMembers,
  runInvites,
  type InviteStats,
} from "./invite";

const SETTINGS_KEY = "invite_bay_settings";

type Settings = {
  apiId: string;
  apiHash: string;
  target: string;
  delayMin: string;
  delayMax: string;
  limit: string;
  dryRun: boolean;
  members: string;
};

const defaultSettings: Settings = {
  apiId: "",
  apiHash: "",
  target: "",
  delayMin: "40",
  delayMax: "90",
  limit: "0",
  dryRun: false,
  members: "",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(data: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "html") node.innerHTML = String(value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value != null) node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function askModal(prompt: string, secret = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const input = el("input", {
      type: secret ? "password" : "text",
      autocomplete: "off",
      inputmode: secret ? "text" : "tel",
    }) as HTMLInputElement;

    const cancel = () => {
      backdrop.remove();
      reject(new Error("Ввод отменён"));
    };
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      backdrop.remove();
      resolve(value);
    };

    const modal = el("div", { class: "modal" }, [
      el("h3", { text: "Авторизация Telegram" }),
      el("p", { text: prompt }),
      el("div", { class: "field" }, [input]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn btn-ghost", type: "button", onClick: cancel, text: "Отмена" }),
        el("button", { class: "btn btn-primary", type: "button", onClick: submit, text: "OK" }),
      ]),
    ]);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") cancel();
    });

    backdrop.append(modal);
    document.body.append(backdrop);
    input.focus();
  });
}

function levelFromMessage(message: string): "info" | "ok" | "warn" | "error" {
  const lower = message.toLowerCase();
  if (lower.includes("peer_flood") || lower.includes("ошибка") || lower.includes("critical")) {
    return "error";
  }
  if (lower.includes("privacy") || lower.includes("floodwait") || lower.includes("пауза") || lower.includes("останов")) {
    return "warn";
  }
  if (lower.includes(" — ok") || lower.startsWith("итог:") || lower.includes("успешн")) {
    return "ok";
  }
  return "info";
}

function mount(): void {
  const root = document.querySelector("#app");
  if (!root) return;

  const saved = loadSettings();
  let controller: AbortController | null = null;
  let running = false;

  const apiId = el("input", {
    value: saved.apiId,
    inputmode: "numeric",
    placeholder: "12345678",
  }) as HTMLInputElement;
  const apiHash = el("input", {
    value: saved.apiHash,
    type: "password",
    placeholder: "api_hash",
    autocomplete: "off",
  }) as HTMLInputElement;
  const target = el("input", {
    value: saved.target,
    placeholder: "@channel или -100...",
  }) as HTMLInputElement;
  const delayMin = el("input", {
    value: saved.delayMin,
    inputmode: "decimal",
  }) as HTMLInputElement;
  const delayMax = el("input", {
    value: saved.delayMax,
    inputmode: "decimal",
  }) as HTMLInputElement;
  const limit = el("input", {
    value: saved.limit,
    inputmode: "numeric",
  }) as HTMLInputElement;
  const dryRun = el("input", {
    type: "checkbox",
  }) as HTMLInputElement;
  dryRun.checked = saved.dryRun;

  const members = el("textarea", {
    placeholder: "username\n@user2\n123456789",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  members.value = saved.members;

  const logBox = el("div", { class: "log", id: "log" });
  const statusPill = el("div", { class: "status-pill", id: "status" }, [
    el("i"),
    document.createTextNode("Готово"),
  ]);

  const statOk = el("b", { text: "0" });
  const statSkip = el("b", { text: "0" });
  const statErr = el("b", { text: "0" });

  const startBtn = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: "Старт",
  }) as HTMLButtonElement;
  const stopBtn = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Стоп",
    disabled: true,
  }) as HTMLButtonElement;

  const setStatus = (text: string, mode: "" | "running" | "error" = "") => {
    statusPill.className = `status-pill ${mode}`.trim();
    statusPill.replaceChildren(el("i"), document.createTextNode(text));
  };

  const appendLog = (message: string, level?: "info" | "ok" | "warn" | "error") => {
    const stamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
    const line = el("div", {
      class: `line ${level || levelFromMessage(message)}`,
      text: `[${stamp}] ${message}`,
    });
    logBox.append(line);
    logBox.scrollTop = logBox.scrollHeight;
  };

  const renderStats = (stats: InviteStats) => {
    statOk.textContent = String(stats.ok + stats.dryRun);
    statSkip.textContent = String(stats.skip + stats.privacy);
    statErr.textContent = String(stats.error + stats.flood);
  };

  const readForm = (): Settings => ({
    apiId: apiId.value.trim(),
    apiHash: apiHash.value.trim(),
    target: target.value.trim(),
    delayMin: delayMin.value.trim(),
    delayMax: delayMax.value.trim(),
    limit: limit.value.trim() || "0",
    dryRun: dryRun.checked,
    members: members.value,
  });

  const persist = () => saveSettings(readForm());

  for (const node of [apiId, apiHash, target, delayMin, delayMax, limit, members]) {
    node.addEventListener("change", persist);
    node.addEventListener("blur", persist);
  }
  dryRun.addEventListener("change", persist);

  startBtn.addEventListener("click", async () => {
    if (running) return;
    const form = readForm();
    persist();

    if (!/^\d+$/.test(form.apiId)) {
      appendLog("API_ID должен быть числом", "error");
      return;
    }
    if (!form.apiHash) {
      appendLog("Укажите API_HASH", "error");
      return;
    }
    if (!form.target) {
      appendLog("Укажите канал / группу", "error");
      return;
    }
    const list = parseMembers(form.members);
    if (!list.length) {
      appendLog("Список пуст", "error");
      return;
    }

    const delayMinN = Number(form.delayMin.replace(",", "."));
    const delayMaxN = Number(form.delayMax.replace(",", "."));
    const limitN = Number(form.limit);
    if (![delayMinN, delayMaxN, limitN].every((n) => Number.isFinite(n))) {
      appendLog("Некорректные числа в параметрах", "error");
      return;
    }

    running = true;
    controller = new AbortController();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus("Выполняется…", "running");
    appendLog("=== Старт ===");

    try {
      await runInvites(
        {
          apiId: Number(form.apiId),
          apiHash: form.apiHash,
          target: form.target,
          members: list,
          delayMin: delayMinN,
          delayMax: delayMaxN,
          dryRun: form.dryRun,
          limit: limitN,
        },
        {
          ask: askModal,
          log: appendLog,
          signal: controller.signal,
          onStats: renderStats,
        },
      );
      setStatus("Готово");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Aborted" && !msg.includes("AbortError")) {
        appendLog(`Критическая ошибка: ${msg}`, "error");
        setStatus("Ошибка", "error");
      } else {
        setStatus("Остановлено");
      }
    } finally {
      running = false;
      controller = null;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      appendLog("=== Конец ===");
    }
  });

  stopBtn.addEventListener("click", () => {
    controller?.abort();
    setStatus("Остановка…", "running");
    appendLog("Запрос остановки…", "warn");
  });

  root.append(
    el("header", { class: "top" }, [
      el("div", { class: "brand" }, [
        el("div", { class: "mark", "aria-hidden": "true" }),
        el("div", {}, [
          el("h1", { text: "Invite Bay" }),
          el("p", { text: "Чистый фронт · Telegram MTProto в браузере" }),
        ]),
      ]),
      el("p", {
        class: "lede",
        text: "Вставьте API ключи и список username/id — инвайты идут с вашего аккаунта прямо из браузера, без сервера.",
      }),
      statusPill,
    ]),

    el("section", { class: "panel" }, [
      el("h2", { text: "API и цель" }),
      el("div", { class: "grid" }, [
        el("div", { class: "row" }, [
          el("div", { class: "field" }, [el("label", { text: "API_ID" }), apiId]),
          el("div", { class: "field" }, [el("label", { text: "API_HASH" }), apiHash]),
        ]),
        el("div", { class: "field" }, [el("label", { text: "Канал / супергруппа" }), target]),
      ]),
      el("p", { class: "hint" }, [
        "Ключи: ",
        el("a", {
          href: "https://my.telegram.org/apps",
          target: "_blank",
          rel: "noopener noreferrer",
          text: "my.telegram.org/apps",
        }),
        " · аккаунт должен быть админом с Invite Users",
      ]),
    ]),

    el("section", { class: "panel" }, [
      el("h2", { text: "Параметры" }),
      el("div", { class: "grid" }, [
        el("div", { class: "row" }, [
          el("div", { class: "field" }, [el("label", { text: "Пауза от, сек" }), delayMin]),
          el("div", { class: "field" }, [el("label", { text: "до, сек" }), delayMax]),
        ]),
        el("div", { class: "row" }, [
          el("div", { class: "field" }, [el("label", { text: "Лимит (0 = все)" }), limit]),
          el("label", { class: "check" }, [dryRun, document.createTextNode("Dry-run")]),
        ]),
      ]),
    ]),

    el("section", { class: "panel" }, [
      el("h2", { text: "Список" }),
      el("div", { class: "field" }, [
        el("label", { text: "Username или user id — по одному на строку" }),
        members,
      ]),
      el("p", {
        class: "hint",
        text: loadSession()
          ? "Сессия Telegram найдена в localStorage — повторный вход обычно не нужен."
          : "При первом входе: телефон → код (часто в чате «Telegram», не SMS) → 2FA если включена.",
      }),
    ]),

    el("section", { class: "panel" }, [
      el("h2", { text: "Результат" }),
      el("div", { class: "stats" }, [
        el("div", { class: "stat" }, [statOk, el("span", { text: "ok" })]),
        el("div", { class: "stat" }, [statSkip, el("span", { text: "skip" })]),
        el("div", { class: "stat" }, [statErr, el("span", { text: "errors" })]),
      ]),
      el("div", { style: "height:10px" }),
      logBox,
      el("p", {
        class: "hint",
        text: "Сессия и настройки хранятся только у вас в браузере. Не открывайте это на чужом устройстве.",
      }),
      el("div", { style: "margin-top:10px" }, [
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Сбросить сессию Telegram",
          onClick: () => {
            clearSession();
            appendLog("Сессия удалена из localStorage", "warn");
          },
        }),
      ]),
    ]),

    el("div", { class: "dock" }, [
      el("div", { class: "dock-inner" }, [stopBtn, startBtn]),
    ]),
  );
}

mount();
