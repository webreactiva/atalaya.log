// Telegram bot over long polling: /<command> [today|yesterday|YYYY-MM-DD] returns that day's log.
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_MESSAGE = 4000; // Telegram cuts at 4096

// "/roast_me@mybot 2026-10-20" → { command: 'roast_me', arg: '2026-10-20' }
export function parseCommand(text) {
  const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text).trim());
  return m ? { command: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

// Splits on line breaks so sentences stay whole when possible
export function chunks(text, size = MAX_MESSAGE) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) out.push(cur), (cur = '');
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > size) out.push(cur.slice(0, size)), (cur = cur.slice(size));
  }
  if (cur) out.push(cur);
  return out;
}

export function telegram(token) {
  const call = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  };
  return {
    call,
    async send(chatId, text) {
      for (const part of chunks(text)) await call('sendMessage', { chat_id: chatId, text: part });
    },
    // Calls handle(message) for each new message; those sent while the bot was stopped are dropped
    async listen(handle) {
      const backlog = await call('getUpdates', { offset: -1, timeout: 0 });
      let offset = backlog.length ? backlog[0].update_id + 1 : 0;
      for (;;) {
        try {
          for (const u of await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] })) {
            offset = u.update_id + 1;
            if (u.message?.text) await handle(u.message);
          }
        } catch (e) {
          console.error(`bot: ${e.message}; retrying in 10 s`);
          await sleep(10_000);
        }
      }
    },
  };
}
