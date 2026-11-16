# Compression benchmarks

English ｜ [繁體中文](benchmarks.zh-TW.md) ｜ [简体中文](benchmarks.zh-CN.md)

Measured on 2026-11-15 and 16 with real chats. How compression works is described in [how-it-works.md](how-it-works.md#compression).

## Method

- Every run used a copy of the chat in a temporary data folder, so the original chat was not touched.
- "Before" comes from the CLIs' own usage logs (Claude `~/.claude/projects`, Codex `~/.codex/sessions`) while the chat was in real use.
- "Tokens re-sent per request" is the size of one request: input, cache writes and cache reads together.
- Each case was run once or twice. Numbers change with chat length, project size and model.

## Three chats, compressed in one go

<p align="center"><img src="../assets/readme/compress-en.svg" width="740" alt="Tokens resent per request before and after compressing: 146 messages Claude 523k to 65k; 96 messages Codex 205k to 30k; 40 messages Claude 653k to 61k"></p>

| Chat | Before, re-sent per request | Compressing | After, re-sent per request |
|---|---|---|---|
| 146 messages, Claude (Opus 5.5) | average 523,000, max 966,000 (session never restarted) | 157 s, 3 parts, 3 requests, 336,000 tokens in total | 58,000–65,000 |
| 96 messages, mostly Codex | average 205,000, max 389,000 | 89 s, 6 parts, 6 requests, 303,000 in total | 25,000–30,000 |
| 40 messages, Claude (Opus 5.5) | 653,000 | 53 s, 3 requests, 187,000 (older method) | 57,000–61,000 |

These runs predate indexing as you chat, so the agent wrote the whole index at compression time.

- **Handing over the text.** An earlier method let the agent read the transcript itself. In the 146-message chat Claude read it in 18 pieces, re-sending everything before each piece, for 2.70 million tokens. Putting the section text in the prompt cut that to 336,000 (88% fewer). With Codex the older method used 266,000 but did not read the whole transcript; the current one costs about 10% more and wrote 36 index entries instead of 24. The 40-message row used the older method.
- **Details afterwards.** We asked two or three questions about early discussion in each chat, 11 in all, and every answer was right. The agent searched the transcript by section number, using 30,000 to 230,000 tokens per turn.
- **When it pays off.** At about 500,000 tokens per request before compressing, the 146-message compression paid for itself within one request. If you restart sessions yourself and requests sit around 150,000, it takes about 4.
- **Very large sessions.** Writing the index inside a 307,000-token session that had seen only part of the chat took 22 requests and 5.5 million tokens. AgentDesk now resumes a session for indexing only when it has seen every section and resuming is cheaper.

## Indexing as you chat

New chats, 5 questions each, real agents:

| Agent | Turns with an index line | Reused the previous topic | Compressing |
|---|---|---|---|
| Codex | 5 / 5 | turns 2 and 4 | 3 entries, 19 ms, no agent run |
| Claude | 5 / 5 | turn 2 | 4 entries, 14 ms, no agent run |

In Claude's 4th turn the working folder's own Stop hook pulled it into an unrelated task; that was the test setup, not the feature.

## Continuing long chats

Two real chats that had already been compressed, copied and continued with 6 questions each:

| | Claude, 150 messages | Codex, 108 messages |
|---|---|---|
| Turns with an index line | 6 / 6 | 6 / 6 |
| Questions about early details | 5 / 5 right | 4 / 4 right |
| Session per request afterwards | 72,000–83,000 | 24,000–59,000 |
| Compressing again | agent indexed the 14 older messages: 1 request, 31 s | agent indexed the 20 older messages: 1 request, 16 s |

The new turns were tidied up directly; only messages from before indexing as you chat needed an agent.

## Caveats

- Tokens are not cost. Most requests in a long session are cache reads, which are cheaper, so the money saved is a smaller share than the tokens saved. In the 146-message run tokens dropped 88%, roughly a quarter less cost at API prices.
- The larger the session, the more compressing saves. Chats with small sessions do not need it.
- The extra tokens for writing the index line each turn have not been measured on their own.
- Cursor and custom agents have not been measured.
