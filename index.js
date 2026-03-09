import fs from "node:fs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import * as cheerio from "cheerio";

const WATCHLIST_PATH = "watchlist.json";
const STATE_PATH = "state.json";

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function normalizeText(s) {
  return (s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function loadJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
function saveJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "site-watch/1.0 (GitHub Actions)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

async function sendDiscord(message) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: message })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${t}`);
  }
}

async function sendEmail(subject, text) {
  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
    EMAIL_FROM, EMAIL_TO
  } = process.env;

  // SMTP 설정이 없으면 이메일은 스킵(Discord만 동작)
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) return;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, text });
}

function getKey(name, url, selector) {
  // name이 바뀌면 state가 새로 잡히는 걸 막기 위해 고정 키를 만듦
  return `${name} | ${url} | ${selector}`;
}

async function main() {
  const watchlist = loadJson(WATCHLIST_PATH, []);
  const state = loadJson(STATE_PATH, {});

  const changes = [];

  for (const item of watchlist) {
    const {
      name,
      url,
      selector,
      mode = "text",
      // 선택: 특정 패턴을 지워서 노이즈 제거하고 싶을 때
      // strip_regex: "(조회\\s*\\d+)|(2026\\.03\\.09)" 같은 식으로 넣을 수 있음
      strip_regex,
      // 선택: 첫 실행에도 알림 받고 싶으면 true
      notify_on_init = false
    } = item;

    if (!name || !url || !selector) {
      console.warn("Skip invalid item (need name/url/selector):", item);
      continue;
    }

    console.log(`Checking: ${name}`);

    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(`Fetch failed: ${name}`, e);
      continue;
    }

    const $ = cheerio.load(html);
    const el = $(selector).first();

    if (!el || el.length === 0) {
      console.error(`Selector not found: ${name}\n  selector=${selector}\n  url=${url}`);
      continue; // selector 실패는 알림 폭탄 방지 위해 스킵
    }

    let content = (mode === "html") ? (el.html() ?? "") : (el.text() ?? "");
    content = normalizeText(content);

    if (strip_regex) {
      try {
        const re = new RegExp(strip_regex, "g");
        content = normalizeText(content.replace(re, ""));
      } catch (e) {
        console.error(`Invalid strip_regex for ${name}: ${strip_regex}`, e);
      }
    }

    const key = getKey(name, url, selector);
    const newHash = sha256(content);
    const prevHash = state[key]?.hash;

    if (!prevHash) {
      state[key] = { hash: newHash, lastSeenAt: new Date().toISOString(), lastContent: content };
      console.log(`Initialized: ${name}`);

      if (notify_on_init) {
        const when = new Date().toISOString();
        const msg =
`[초기 기준 저장] ${name}
URL: ${url}
시각(UTC): ${when}

기준 내용(일부):
${content.slice(0, 800)}${content.length > 800 ? "\n...(생략)" : ""}`;
        changes.push({ name, msg, emailSubject: `[초기 기준 저장] ${name}` });
      }
      continue;
    }

    if (prevHash !== newHash) {
      const when = new Date().toISOString();
      const old = state[key]?.lastContent ?? "";
      state[key] = { hash: newHash, lastSeenAt: when, lastContent: content };

      const msg =
`[변경 감지] ${name}
URL: ${url}
시각(UTC): ${when}

변경 전(일부):
${old.slice(0, 400)}${old.length > 400 ? "\n...(생략)" : ""}

변경 후(일부):
${content.slice(0, 800)}${content.length > 800 ? "\n...(생략)" : ""}`;

      changes.push({ name, msg, emailSubject: `[변경 감지] ${name}` });
    } else {
      state[key].lastSeenAt = new Date().toISOString();
    }
  }

  saveJson(STATE_PATH, state);

  for (const c of changes) {
    await sendDiscord(c.msg);
    await sendEmail(c.emailSubject, c.msg);
  }

  console.log(`Done. Changes: ${changes.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
