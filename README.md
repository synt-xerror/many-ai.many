# many-ai

AI agent for ManyBot using Groq API.

## How to set up

- Access: https://console.groq.com
- Log in (GitHub or Google).
- Click on "Create API key".
- Copy the key and paste it into "GROQ_API_KEY" in the settings (~/.manybot/manybot.toml).

It is also possible for this agent to perform internet searches; for this, you need two API keys to ensure that the search is successful and accurate (optional):

- Tavily:
    - Access: https://app.tavily.com/home.
    - Log in.
    - In "API Keys", click to add a new one ("+").
    - Copy and paste into "TAVILY_API_KEY".

- Serper:
    - Access: https://serper.dev/dashboard
    - Click on "API Keys" in the upper right corner.
    - Click on "Create New Key".
    - Copy and paste into "SERPER_API_KEY".


manybot.toml should look like this:
```
GROQ_API_KEY = "gsk_..."
TAVILY_API_KEY = "tvly-dev-..."
SERPER_API_KEY = "abc1234..."
```

## Triggers
By default, the bot responds to `<prefix>ai <prompt>`. You can also configure additional triggers:

- **`MANYAI_TRIGGERS`** — plain substring match (no word boundary). Ex: `["!ai", "manybot"]`
- **`MANYAI_WORD_TRIGGERS`** — isolated word match (`\bword\b`). Default: `["many"]`. Ex: `["many", "ei", "bot"]`

With `MANYAI_WORD_TRIGGERS`, "many, what's the weather?" triggers but "manybot" does not.

```ini
MANYAI_TRIGGERS = ["ai"]
MANYAI_WORD_TRIGGERS = ["many","ei"]
```

## How to use

On any chat, everyone that send "<prefix>ai <prompt>" will be automatically answered by the AI.

Like:
```
> search me the news?
> !ai
< A portal to Equestria has been found today in Xique-Xique Bahia, in Brazil.
```

