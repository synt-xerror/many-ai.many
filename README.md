# many-ai

AI agent for ManyBot, powered by Groq. No fixed persona — name, personality,
purpose and extra behavior are 100% configurable. Multiple API key support
with automatic failover, per-chat memory, local searchable chat history,
optional passive intervention, voice transcription, and sticker sending.
Available in Portuguese, English and Spanish.

## Quick setup

1. Free key: https://console.groq.com → "Create API key".
2. In `~/.manybot/manybot.toml`:

```toml
GROQ_API_KEY = "gsk_..."
```

3. Restart. Without a key, the log shows `GROQ_API_KEY not configured...`.

Out of the box, with nothing else configured, the bot replies to `!ai <question>`
(via the built-in `ai` command) and to replies/quotes of its own messages.
There's no word trigger and no persona until you configure them — it's a
neutral assistant by default.

## Identity (nothing assumed by default)

```toml
AI_NAME = "Bia"
AI_PERSONALITY = "Direct, dry, dry humor. No emoji."
AI_PURPOSE = "Rust study group. Focus on helping with technical questions."
AI_EXTRA_INSTRUCTIONS = "If asked about stickers, tell them to use !help figurinha."
```

If `AI_NAME` is set and `MANYAI_WORD_TRIGGERS` isn't, the name itself becomes
a word trigger automatically (e.g. `AI_NAME = "Bia"` → "Bia, hey" already
works). Set `MANYAI_WORD_TRIGGERS` manually to override that.

### Customization knobs

The prompt's structure (rules, tool contracts, behavior) is fixed — that's
the shared "universal default" every instance runs on. What's tunable on top
of identity/personality/purpose above:

```toml
AI_EMOJIS = false        # allow emojis in replies (off by default)
AI_REPLY_LENGTH = "short" # "short" (1-2 sentences) | "normal" | "long"
```

## How the bot gets triggered

Any of the following counts as a trigger:

- **Command** — `!<MANYAI_COMMAND>` (default `ai`, so `!ai <question>`). An
  empty `MANYAI_COMMAND` disables this entirely. This is the only trigger
  kind that disables `SILENT` — a direct command always gets a real answer.
- **Word trigger** — a whole-word match against `MANYAI_WORD_TRIGGERS`
  (defaults to `[AI_NAME]` if a name is set, otherwise empty).
- **Literal trigger** — a plain substring match against `MANYAI_TRIGGERS`
  (empty `[]` by default — not set to `!ai` out of the box, since the
  command above already covers that case).
- **Quoting the bot's own message** — replying to any message the bot sent
  always works, with or without extra text, in both DMs and groups. Only
  works for messages sent since the last restart (tracked in memory, last
  500 message IDs).
- **Continuation** — right after the bot replies to someone, a 3-minute
  window opens for that *same sender* to keep talking without repeating the
  trigger. It closes as soon as someone else speaks in the chat, or after 3
  minutes. A continuation-triggered reply never extends its own window —
  otherwise the bot would keep answering the same person indefinitely.

## Multiple API keys

```toml
GROQ_API_KEYS = ["gsk_key1", "gsk_key2", "gsk_key3"]
```

When a key hits a rate limit, the next available one is used automatically.
The limited key is put on cooldown — Groq's own "try again in Xs" hint if
present, otherwise 30s — and becomes available again after that. Rotation
picks up from the last key that was actually used, so load spreads across
the pool instead of always hammering key #1. `GROQ_API_KEY` still works on
its own and is merged into the pool if `GROQ_API_KEYS` is also set.

## Turning it on/off per chat (not everyone wants this)

```
!ai-settings status              -> shows the chat's current state
!ai-settings off / on            -> disables/re-enables the AI for this chat
!ai-settings intervention on/off -> toggles passive intervention (below)
!ai-settings transcribe on/off   -> toggles background audio transcription (below)
!ai-settings sticker on/off      -> toggles the AI sending stickers (below), on by default
```

In groups, only admins can change settings (anyone can check `status`). This
command still works even with the AI disabled — it's the only way to turn it
back on. Configurable via `MANYAI_SETTINGS_COMMAND` (default `ai-settings`).

## Passive intervention (opt-in, off by default)

With `!ai-settings intervention on`, in groups the bot starts considering
joining the conversation without being called. Cheap local filters run
first, purely to avoid burning an API call on obvious noise (a "kk", a
reaction, anything under 12 characters) — the actual "should I say
something" decision always comes from the model itself, defaulting to
`SILENT`. Two paths reach the model:

- The message **ends with `?`** and isn't trivially short → treated as a
  possibly-unanswered question. The bot waits `AI_INTERVENTION_WAIT_MINUTES`
  (default 1) before checking; if anything else was said in the chat in the
  meantime, it backs off instead of checking.
- The message **matches a help-request pattern** (contains `?`, or a
  language-specific keyword like "ajuda"/"erro"/"como faço" in Portuguese,
  "help"/"how do i"/"error" in English) → checked right away.

Note: correcting a "technical/factual error" is one of the three cases the
model is allowed to act on, but it has no filter of its own — it only gets a
chance to run when the message already matched the help-request pattern
above (which is why "erro"/"problema" are in that keyword list). A plain
wrong statement with no question mark and no matching keyword never reaches
the model.

Uses a lighter model by default (`AI_PASSIVE_MODEL`, default
`llama-3.1-8b-instant`), since it runs on more messages than a direct
trigger would. Passive checks always run against a scratch copy of the
chat's history — only an actual reply gets recorded back into it, so the
many `SILENT` checks along the way don't pollute future context.

```toml
AI_INTERVENTION_WAIT_MINUTES = 1   # wait time before checking an unanswered question
AI_PASSIVE_MODEL = "llama-3.1-8b-instant"
```

In DMs, the same `intervention on/off` toggle applies but skips the wait
timer entirely — a 1:1 chat is already implicitly addressed to the bot, so
it just checks directly (still subject to the same length filter and the
model's own judgment).

## Voice / audio

```
!ai-settings transcribe on/off   -> background audio transcription (off by default)
```

- **Explicitly asking about an audio message** ("summarize this voice note")
  by replying to it always works, on demand, regardless of the toggle above.
- **Background transcription** controls whether an audio message that
  arrives directly in the chat (not quoted) gets transcribed and folded into
  the pipeline at all. With it off, a direct audio message only gets a
  reply if it was itself a trigger (and that reply just says transcription
  is disabled) — a non-trigger audio message is otherwise ignored. With it
  on, every audio message is transcribed and indexed like a normal chat
  message (searchable via `SEARCH_HISTORY`). Off by default since
  processing other people's voice without them knowing is more sensitive
  than the AI just talking on its own.
- Uses Groq Whisper (`whisper-large-v3-turbo` by default, configurable via
  `AI_TRANSCRIBE_MODEL`), same `GROQ_API_KEY`/`GROQ_API_KEYS` pool.
- Transcribing a **quoted** audio message (not the current one) depends on
  `baileys` as a dependency, loaded lazily on first use — the plugin API
  doesn't expose downloading a quoted message's media, only the current
  one. Best-effort: if the installed version doesn't match or the package
  isn't there, that specific case silently stops working without affecting
  anything else.

## Stickers

```
!ai-settings sticker on/off   -> lets the AI decide when to send one (on by default)
```

The AI can send a sticker on its own initiative — a reaction, a joke, a
greeting — never forced, only when it genuinely fits. Images live in the
plugin's own data folder, described in a manifest the model reads at prompt
time:

```
~/.manybot/data/many-ai/stickers/
├── stickers.json
├── many-blueberry.jpg
└── many-sad.jpg
```

`stickers.json`:

```json
[
  { "file": "many-blueberry.jpg", "description": "Mascot wearing a blueberry, smiling. cute/silly/funny." },
  { "file": "many-sad.jpg", "description": "Mascot disappointed, not serious, still funny" }
]
```

- Any image format works (jpg, png, webp, gif...) — converted to `.webp` on
  the fly via `wa-sticker-formatter`, with pack/author metadata baked in
  (configurable below).
- The `description` is what the model actually reads to decide whether a
  given sticker fits the moment — write it as the context where it should be
  used, not just what's in the image.
- The list is closed: the model is told these are the *only* stickers that
  exist, never to invent one. If someone explicitly asks for a sticker and
  nothing fits, it says so instead of pretending to send one.
- If `stickers.json` is missing/empty or the toggle is off, the sticker tool
  is left out of the prompt entirely — the model doesn't know stickers exist
  at all, so it never brings up not having any.
- Editing `stickers.json` or adding/removing files takes effect on the next
  message — no restart needed, the manifest is read fresh every time.

```toml
STICKER_PACK_NAME = "Many AI"     # pack name baked into every sticker sent
STICKER_AUTHOR_NAME = "ManyBot"   # author baked into every sticker sent
```

Note these two are bot-wide (`ctx.config`), not per-chat like the on/off
toggle above (`ctx.settings`) — one pack/author identity across every chat
the bot is in.

## First-time / experimental-feature disclaimer


The first time someone directly triggers the AI (or the first time after 3
full days without triggering it), a short disclaimer follows the reply,
warning that it's an experimental AI feature and can make mistakes. Tracked
per sender in its own local database — resets for a given person after 3
days of inactivity, same idea as the "first time" greeting in `many-help`,
but a separate table so the two don't interfere with each other. Only fires
after the bot actually sends a real reply on a direct trigger — never on
`SILENT`, and never on a passive-intervention reply nobody asked for.

## Tools

| Tool | What it does |
|---|---|
| **Web search** | News, results, dates, anything the model doesn't know. Tries Tavily, then Serper, then a handful of public SearXNG instances, then a DuckDuckGo HTML scrape, then a Wikipedia (pt) summary as a last resort — each attempt capped at 8s. |
| **Memory** | Facts saved per chat via `MEM_WRITE`, recalled via `MEM_READ` — a group's memory never leaks into another group or DM. `MEM_READ *` returns everything saved (up to 20 most recent); a specific query does a `LIKE` search (up to 10 matches). |
| **Calculator** | Exact arithmetic instead of letting the model "guess" numbers — expressions are whitelisted before evaluation. |
| **Group info** | Name, participant count, admin count, admin names, whether the bot itself is admin. Returns raw data for the model to phrase naturally, not a canned sentence. |
| **Search history** | Every text message in the chat is indexed locally (SQLite + FTS5, no API cost, LIKE-search fallback if FTS5 isn't available). "Who sent that Rust link last month?" searches the local index and only the matched result goes to the model — never the full history. Kept for 90 days per chat, pruned opportunistically. |
| **Stickers** | Sends one from the configured manifest when it genuinely fits — see [Stickers](#stickers) above. Closed list, never invented. |

The model is instructed to never guess a volatile fact (scores, prices,
news, anything that could be stale) — for those, its first reply must
always be a `SEARCH ...` call, even if it's "pretty sure".

## Other configs

```toml
TAVILY_API_KEY = "tvly-dev-..."      # optional, better search
SERPER_API_KEY = "abc1234..."        # optional, better search
GROQ_MODEL = "llama-3.3-70b-versatile"
LANGUAGE = "pt"                      # "pt", "en" or "es"
MANYAI_TRIGGERS = ["!ai"]            # plain substring match (empty by default)
MANYAI_WORD_TRIGGERS = ["bia", "hey"] # whole-word match (\bword\b)
MANYAI_COMMAND = "ai"                # command !<this> — empty disables it
MANYAI_SETTINGS_COMMAND = "ai-settings"
MANYAI_MAX_TOKENS = 300
AI_EMOJIS = false                    # allow emojis in replies
AI_REPLY_LENGTH = "short"            # "short" | "normal" | "long"
AI_TRANSCRIBE_MODEL = "whisper-large-v3-turbo"
AI_INTERVENTION_WAIT_MINUTES = 1
AI_PASSIVE_MODEL = "llama-3.1-8b-instant"
STICKER_PACK_NAME = "Many AI"
STICKER_AUTHOR_NAME = "ManyBot"
```

## How it reads WhatsApp

- **Private vs. group**: told explicitly to the model.
- **Current vs. old message**: the message that triggered the reply is
  tagged `[CURRENT MESSAGE]`; the rest of the recent history is
  `[OLD MESSAGE]` — background only, never something to re-answer on its
  own.
- **Other plugins' commands** (any `!something` that isn't the AI's own
  trigger) show up tagged `[Command]`, as background context only — the
  model never replies to those directly.
- **Reply/quote**: when the current message replies to another one, the
  quoted content is extracted and shown as
  `[replying to Fulano: "quoted text"]` (capped at 200 characters). If the
  quoted message is a voice note with no caption, it's transcribed on
  demand for this specific case, regardless of the background transcription
  setting.
- Images, videos, stickers and documents are never actually seen — only a
  label like `(sticker message, no caption)`. The model is told not to
  volunteer this limitation unless it's genuinely relevant (someone
  explicitly asks it to look at/describe media, or the conversation makes
  no sense without knowing what was there).

## Troubleshooting

- **Never replies**: check the startup log — `GROQ_API_KEY not configured`
  means no key (single or pool) was found.
- **Constant rate limits even with several keys**: all of them are cooling
  down at the same time — normal under heavy use, retry shortly.
- **Empty admin list in a group**: depends on the exact shape
  `getParticipants()` returns for that WhatsApp connection; participant
  name/count still work regardless.
- **Model keeps calling tools and never answers**: after 5 tool-call
  iterations (3 during a passive check) the plugin gives up silently —
  nothing is sent, only a warning in the log.
- **A model attempts native function-calling and fails**: some Groq models
  (e.g. gpt-oss) try native tool calls even though this plugin only asks for
  plain-text `COMMAND(arg)` output. Groq rejects that with a `400
  tool_use_failed` — the plugin detects this and recovers the intended call
  from the error body automatically, so it still runs; you shouldn't notice
  this happening.
- **The experimental-feature disclaimer never shows up**: it relies on
  Node's built-in `node:sqlite` module (separate from the `sqlite3` package
  used by memory/history), which needs a reasonably recent Node.js version.
  If that module isn't available, the disclaimer is silently skipped rather
  than crashing the plugin.
- **AI never sends stickers**: check the log line
  `stickers dir="..." found=N` on the next trigger — `found=0` means
  `stickers.json` is missing/empty/invalid at that exact path, or the images
  are somewhere else. The path is always
  `~/.manybot/data/many-ai/stickers/`, **not** wherever the plugin's source
  code lives — it's the bot's own data directory (`ctx.storage`).
