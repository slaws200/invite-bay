import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { RPCError } from "telegram/errors";

export type InviteParams = {
  apiId: number;
  apiHash: string;
  target: string;
  members: string[];
  delayMin: number;
  delayMax: number;
  dryRun: boolean;
  limit: number;
};

export type InviteStats = {
  ok: number;
  dryRun: number;
  skip: number;
  privacy: number;
  flood: number;
  error: number;
};

export type AskFn = (prompt: string, secret?: boolean) => Promise<string>;
export type LogFn = (message: string, level?: "info" | "ok" | "warn" | "error") => void;

const SESSION_KEY = "invite_bay_session";

export function loadSession(): string {
  return localStorage.getItem(SESSION_KEY) || "";
}

export function saveSession(value: string): void {
  localStorage.setItem(SESSION_KEY, value);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function parseMembers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    // "1030. @user" / "12) user" / "1: @user"
    raw = raw.replace(/^\d+\s*[.\)\-:]\s*/, "").trim();
    const match = raw.match(/@[A-Za-z]\w{3,31}\b|[A-Za-z]\w{3,31}\b|-?\d{5,}\b/);
    const token = (match?.[0] || raw.split(/\s+/)[0] || "").trim();
    if (!token) continue;
    const key = token.toLowerCase().replace(/^@/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function normalizeId(value: string): string | number {
  const cleaned = value.trim().replace(/^@/, "");
  if (/^-?\d+$/.test(cleaned)) return Number(cleaned);
  return cleaned;
}

function targetCandidates(target: string): Array<string | number> {
  const raw = target.trim();
  const out: Array<string | number> = [];
  const push = (v: string | number) => {
    if (!out.some((x) => String(x) === String(v))) out.push(v);
  };

  const fromLink = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^t\.me\//i, "")
    .split(/[/?#]/)[0]
    ?.trim();

  const cleaned = (fromLink && raw.toLowerCase().includes("t.me/") ? fromLink : raw).replace(/^@/, "");

  if (/^\d+$/.test(cleaned)) {
    push(Number(cleaned));
    push(Number(`-100${cleaned}`));
    push(`-100${cleaned}`);
  } else if (/^-100\d+$/.test(cleaned)) {
    push(Number(cleaned));
    push(cleaned);
    push(Number(cleaned.slice(4)));
  } else if (/^-\d+$/.test(cleaned)) {
    push(Number(cleaned));
    push(cleaned);
  } else {
    push(cleaned);
  }

  return out;
}

async function resolveTarget(
  client: TelegramClient,
  target: string,
  log: LogFn,
): Promise<Api.User | Api.Chat | Api.Channel> {
  const candidates = targetCandidates(target);
  let lastErr: unknown;

  for (const candidate of candidates) {
    try {
      return (await client.getEntity(candidate)) as Api.User | Api.Chat | Api.Channel;
    } catch (err) {
      lastErr = err;
    }
  }

  log("Цель не в кэше — загружаю диалоги аккаунта…", "warn");
  const dialogs = await client.getDialogs({ limit: 500 });

  const want = new Set(candidates.map(String));
  for (const c of [...want]) {
    if (/^-100\d+$/.test(c)) want.add(c.slice(4));
    if (/^\d+$/.test(c)) want.add(`-100${c}`);
  }

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity || !("id" in entity)) continue;
    const id = String(entity.id);
    const username =
      "username" in entity && entity.username ? String(entity.username).toLowerCase() : "";
    if (want.has(id) || want.has(`-100${id}`) || (username && want.has(username))) {
      return entity as Api.User | Api.Chat | Api.Channel;
    }
  }

  for (const candidate of candidates) {
    try {
      return (await client.getEntity(candidate)) as Api.User | Api.Chat | Api.Channel;
    } catch (err) {
      lastErr = err;
    }
  }

  const detail = lastErr ? errorText(lastErr) : "unknown";
  throw new Error(
    `Не найден канал/группа «${target}». Укажите @username или откройте его в Telegram с этого аккаунта (нужен доступ админа). Детали: ${detail}`,
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function randDelay(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.random() * (b - a);
}

function errorText(err: unknown): string {
  if (err instanceof RPCError) return `${err.errorMessage || err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function runInvites(
  params: InviteParams,
  opts: {
    ask: AskFn;
    log: LogFn;
    signal: AbortSignal;
    onStats: (stats: InviteStats) => void;
  },
): Promise<InviteStats> {
  const stats: InviteStats = {
    ok: 0,
    dryRun: 0,
    skip: 0,
    privacy: 0,
    flood: 0,
    error: 0,
  };

  const bump = () => opts.onStats({ ...stats });
  bump();

  let members = [...params.members];
  if (params.limit > 0) members = members.slice(0, params.limit);

  opts.log(`Загружено ${members.length} идентификаторов`);
  opts.log(`Цель: ${params.target}`);
  if (params.dryRun) opts.log("Dry-run: инвайты не выполняются", "warn");

  const session = new StringSession(loadSession());
  const client = new TelegramClient(session, params.apiId, params.apiHash, {
    connectionRetries: 5,
    useWSS: true,
  });

  const normalizePhone = (raw: string): string => {
    const trimmed = raw.trim().replace(/[\s()-]/g, "");
    if (trimmed.startsWith("00")) return `+${trimmed.slice(2)}`;
    if (trimmed.startsWith("+")) return trimmed;
    return `+${trimmed}`;
  };

  try {
    opts.log("Подключение к Telegram…");
    await client.start({
      phoneNumber: async () => {
        const raw = await opts.ask("Номер телефона в международном формате (+7900…)", false);
        const phone = normalizePhone(raw);
        opts.log(`Запрос кода для ${phone}…`);
        return phone;
      },
      phoneCode: async (isCodeViaApp?: boolean) => {
        if (isCodeViaApp) {
          opts.log("Код отправлен в приложение Telegram (чат «Telegram»), не в SMS", "ok");
          return opts.ask("Код из приложения Telegram", false);
        }
        opts.log("Код отправлен по SMS", "ok");
        return opts.ask("Код из SMS", false);
      },
      password: async () => opts.ask("Пароль двухфакторной аутентификации", true),
      onError: async (err) => {
        const msg = errorText(err);
        opts.log(`Auth: ${msg}`, "error");
        const fatal =
          msg.includes("FLOOD") ||
          msg.includes("PHONE_NUMBER_BANNED") ||
          msg.includes("PHONE_NUMBER_INVALID") ||
          msg.includes("API_ID_INVALID") ||
          msg.includes("API_ID_PUBLISHED");
        return fatal;
      },
    });

    saveSession(String(client.session.save()));
    opts.log("Авторизация успешна", "ok");

    const channel = await resolveTarget(client, params.target, opts.log);
    opts.log(`Цель найдена: ${"title" in channel ? channel.title : params.target}`, "ok");

    for (let i = 0; i < members.length; i += 1) {
      if (opts.signal.aborted) {
        opts.log("Остановлено пользователем", "warn");
        break;
      }

      const raw = members[i];
      const label = `[${i + 1}/${members.length}] ${raw}`;

      try {
        const user = await client.getEntity(normalizeId(raw));
        if (params.dryRun) {
          opts.log(`${label} — dry-run`, "ok");
          stats.dryRun += 1;
        } else {
          await client.invoke(
            new Api.channels.InviteToChannel({
              channel,
              users: [user],
            }),
          );
          opts.log(`${label} — ok`, "ok");
          stats.ok += 1;
        }
      } catch (err) {
        const msg = errorText(err);
        if (msg.includes("USER_PRIVACY_RESTRICTED")) {
          opts.log(`${label} — privacy`, "warn");
          stats.privacy += 1;
        } else if (msg.includes("USER_ALREADY_PARTICIPANT")) {
          opts.log(`${label} — уже участник`, "warn");
          stats.skip += 1;
        } else if (msg.includes("PEER_FLOOD")) {
          opts.log(`${label} — PEER_FLOOD, остановка`, "error");
          stats.flood += 1;
          bump();
          break;
        } else if (msg.includes("FLOOD_WAIT")) {
          const match = msg.match(/(\d+)/);
          const waitSec = match ? Number(match[1]) + 5 : 30;
          opts.log(`${label} — FloodWait ${waitSec}s`, "warn");
          stats.flood += 1;
          await sleep(waitSec * 1000, opts.signal);
          i -= 1;
        } else if (
          msg.includes("UsernameNotOccupied") ||
          msg.includes("USERNAME_NOT_OCCUPIED") ||
          msg.includes("No user has") ||
          msg.includes("Cannot find any entity")
        ) {
          opts.log(`${label} — не найден`, "warn");
          stats.skip += 1;
        } else if (msg.includes("CHAT_WRITE_FORBIDDEN") || msg.includes("CHAT_ADMIN_REQUIRED")) {
          opts.log(`${label} — нет прав. Остановка.`, "error");
          stats.error += 1;
          bump();
          break;
        } else {
          opts.log(`${label} — ${msg}`, "error");
          stats.error += 1;
        }
      }

      bump();

      if (!params.dryRun && i < members.length - 1 && !opts.signal.aborted) {
        const pause = randDelay(params.delayMin, params.delayMax);
        opts.log(`  пауза ${pause.toFixed(1)}s`);
        await sleep(pause * 1000, opts.signal);
      }
    }
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }

  opts.log(
    `Итог: ok=${stats.ok}, dry-run=${stats.dryRun}, skip=${stats.skip}, privacy=${stats.privacy}, flood=${stats.flood}, error=${stats.error}`,
    "ok",
  );
  bump();
  return stats;
}
