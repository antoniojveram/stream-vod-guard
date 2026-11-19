import { config } from './config.js';
import { logger } from './logger.js';
import { truncate } from './util.js';

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function notify(title, message = '', { priority = 'default', tags = [] } = {}) {
  const jobs = [];

  if (config.notify.ntfyUrl && config.notify.ntfyTopic) {
    const base = config.notify.ntfyUrl.replace(/\/$/, '');
    const headers = { Title: title, Priority: priority, Tags: tags.join(',') };
    if (config.notify.ntfyToken) headers.Authorization = `Bearer ${config.notify.ntfyToken}`;
    jobs.push(fetch(`${base}/${encodeURIComponent(config.notify.ntfyTopic)}`, {
      method: 'POST',
      headers,
      body: message,
      signal: AbortSignal.timeout(10000),
    }));
  }

  if (config.notify.telegramBotToken && config.notify.telegramChatId) {
    jobs.push(postJson(
      `https://api.telegram.org/bot${config.notify.telegramBotToken}/sendMessage`,
      { chat_id: config.notify.telegramChatId, text: `${title}\n${message}`, disable_web_page_preview: true },
    ));
  }

  if (config.notify.discordWebhook) {
    jobs.push(postJson(config.notify.discordWebhook, {
      content: `**${title}**${message ? `\n${message}` : ''}`.slice(0, 1900),
    }));
  }

  if (!jobs.length) return false;
  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(`Notification failed: ${truncate(result.reason?.message || result.reason, 200)}`);
    }
  }
  return true;
}

export async function notifyLive(session) {
  if (!config.notify.onLive) return;
  await notify(
    `🔴 ${session.platform === 'twitch' ? 'Twitch' : 'YouTube'} live: ${session.title}`,
    `${session.platform} · ${session.game || 'Uncategorized'} · recording started`,
    { priority: 'high', tags: ['red_circle'] },
  );
}

export async function notifyFinal(session, summary) {
  const ok = summary?.muteChecks?.failed === 0;
  await notify(
    `${ok ? '✅' : '⚠️'} Recording finished: ${session.title}`,
    summary?.line || '',
    { priority: ok ? 'default' : 'high', tags: [ok ? 'white_check_mark' : 'warning'] },
  );
}

export async function notifyError(title, error) {
  await notify(`⚠️ ${title}`, truncate(error, 500), { priority: 'high', tags: ['warning'] });
}
