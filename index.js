// ===================================================
// FILE: index.js
// ===================================================

// TRANSLATOR BOT v6 -- "MODO AUTOBORRAR" + Contact Importer endpoint
// The bot adds a small 🌐 reaction to eligible messages. Click it -> the
// translation appears right there in the channel, as a reply directly under
// the message. It auto-deletes itself 60 seconds later.
//
// ALSO exposes a small HTTP server with a /contacts endpoint that reads the
// #daily-contact-list channel history and returns parsed phone contacts —
// used by the VAAS Closer Bot dashboard to import leads into "Revisión".

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');
const express = require('express');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IMPORT_SECRET = process.env.BOT_IMPORT_SECRET;
const TRANSLATE_EMOJI = '🌐';
const AUTO_DELETE_SECONDS = parseInt(process.env.AUTO_DELETE_SECONDS || '60', 10);
const EXCLUDE_CHANNEL_NAMES = (process.env.EXCLUDE_CHANNEL_NAMES || 'wins')
  .split(',')
  .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
  .filter(Boolean);

if (!DISCORD_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('Missing required env vars: DISCORD_TOKEN, ANTHROPIC_API_KEY');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const activeTranslations = new Set();

const URL_ONLY_REGEX = /^\s*https?:\/\/\S+\s*$/i;

function isEligibleForTranslation(message) {
  if (message.author?.bot) return false;
  const rawChannelName = message.channel?.name?.toLowerCase() || '';
  const normalizedChannelName = rawChannelName.replace(/[^a-z0-9]/g, '');
  if (EXCLUDE_CHANNEL_NAMES.includes(normalizedChannelName)) return false;
  const content = message.content?.trim();
  if (!content) return false;
  if (URL_ONLY_REGEX.test(content)) return false;
  if (content.startsWith('!') || content.startsWith('/')) return false;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) return false;
  return true;
}

async function translateBoth(text) {
  const systemPrompt = `You are a translation engine inside a Discord bot for a bilingual (English/Spanish) team. Members freely mix both languages in the same message (code-switching).

Given a Discord message, produce two COMPLETE, natural, idiomatic versions of the entire message:
- "spanish": the whole message fully in Spanish
- "english": the whole message fully in English

Keep tone, slang, emojis, and line breaks. If the message is already fully in one language, still return a complete, natural translation for the other field, and you may echo the original for its own language field.

Respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{"spanish":"...","english":"..."}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const cleaned = raw.replace(/^```json\s*|^```\s*|```$/g, '').trim();
  return JSON.parse(cleaned);
}

client.once('ready', () => {
  console.log(`Translator bot online as ${client.user.tag}`);
  console.log(`Mode: MODO AUTOBORRAR (react to show, auto-deletes after ${AUTO_DELETE_SECONDS}s)`);
});

client.on('messageCreate', async (message) => {
  try {
    if (!isEligibleForTranslation(message)) return;
    await message.react(TRANSLATE_EMOJI);
  } catch (err) {
    console.error('Error adding translate reaction:', err);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.emoji.name !== TRANSLATE_EMOJI) return;

    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    if (activeTranslations.has(message.id)) return;

    const content = message.content?.trim();
    if (!content) return;

    activeTranslations.add(message.id);

    const result = await translateBoth(content);

    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .addFields(
        { name: '🇪🇸 Español', value: result.spanish || '—' },
        { name: '🇬🇧 English', value: result.english || '—' }
      )
      .setFooter({ text: `Se borra en ${AUTO_DELETE_SECONDS}s` });

    const replyMsg = await message.reply({
      embeds: [embed],
      allowedMentions: { repliedUser: false },
    });

    setTimeout(async () => {
      try {
        await replyMsg.delete();
      } catch (_) {}
      activeTranslations.delete(message.id);
    }, AUTO_DELETE_SECONDS * 1000);
  } catch (err) {
    console.error('Error handling translate reaction:', err);
    activeTranslations.delete(reaction.message?.id);
  }
});

client.on('error', (err) => console.error('Client error:', err));

// ===================================================
// CONTACT IMPORTER — reads #daily-contact-list history
// ===================================================

// Parses a raw Discord message's text content into one or more contact
// blocks. Each block starts at a line containing "Contact:" and collects
// the Product / Videos / Price lines that follow, until the next "Contact:"
// line or the end of the message.
function parseContactBlocks(content, messageId, createdAt) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  let blockIndex = 0;

  for (const line of lines) {
    const contactMatch = line.match(/Contact:\s*(.+)/i);
    if (contactMatch) {
      if (current) blocks.push(current);
      const value = contactMatch[1].trim();
      const isPhone = /^[+\d][\d\s()-]{6,}$/.test(value);
      const isEmail = value.includes('@');
      current = {
        discord_message_key: `${messageId}-${blockIndex}`,
        phone: isPhone ? value : null,
        isEmail,
        product: null,
        videos_text: null,
        price_text: null,
        created_at: createdAt,
      };
      blockIndex += 1;
      continue;
    }
    if (!current) continue;

    const productMatch = line.match(/Product:\s*(.+)/i);
    if (productMatch) {
      const val = productMatch[1].trim();
      current.product = val === '—' || val === '-' ? null : val;
      continue;
    }

    const videosMatch = line.match(/(\d+)\s*Videos?/i);
    if (videosMatch) {
      current.videos_text = videosMatch[0];
      continue;
    }

    const priceMatch = line.match(/\$[\d,]+/);
    if (priceMatch) {
      current.price_text = priceMatch[0];
      continue;
    }
  }
  if (current) blocks.push(current);

  // Only keep blocks that had a real phone number (skip email-only contacts).
  return blocks.filter((b) => b.phone && !b.isEmail);
}

async function fetchContactsInRange(channelId, sinceMs, untilMs) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error('Canal no encontrado');

  let allContacts = [];
  let beforeId = undefined;
  let keepGoing = true;

  while (keepGoing) {
    const batch = await channel.messages.fetch({ limit: 100, before: beforeId });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      const ts = message.createdTimestamp;
      if (ts < sinceMs) {
        keepGoing = false;
        continue;
      }
      if (ts > untilMs) continue;
      if (!message.content) continue;

      const blocks = parseContactBlocks(message.content, message.id, new Date(ts).toISOString());
      allContacts = allContacts.concat(blocks);
    }

    beforeId = batch.last()?.id;
    if (!beforeId) break;
    if (batch.last().createdTimestamp < sinceMs) keepGoing = false;
  }

  return allContacts;
}

// ---- HTTP server ----
const app = express();
app.use(express.json());

app.get('/contacts', async (req, res) => {
  try {
    if (!IMPORT_SECRET || req.headers['x-import-secret'] !== IMPORT_SECRET) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    const { channelId, since, until } = req.query;
    if (!channelId || !since || !until) {
      return res.status(400).json({ error: 'Faltan parámetros: channelId, since, until' });
    }
    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();
    const contacts = await fetchContactsInRange(channelId, sinceMs, untilMs);
    res.json({ ok: true, contacts });
  } catch (err) {
    console.error('Error en /contacts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server (contact importer) escuchando en puerto ${PORT}`));

client.login(DISCORD_TOKEN);
