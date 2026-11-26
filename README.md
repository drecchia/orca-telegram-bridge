# Telegram Bridge

An Orca `trusted-worker` + `components` sidebar plugin that connects Telegram bots to your local Orca bots for real-time two-way chat. Each **bridge** links one Telegram bot to one Orca bot; run as many bridges as you like.

Fork of the original plugin by [HenryMa96](https://github.com/henryma96/orca-telegram-bridge).

<p align="center">
  <img src="docs/images/setup-card.png" alt="The Telegram panel in Orca's right sidebar: Setup, Chats, Logs and Audit tabs, and the card of one bridge with its Active switch, people, groups and voice summary, and an Edit button" width="420">
</p>

**Talk to your Orca bots from Telegram, from your phone, anywhere.**

- **As many bridges as you need.** Each bridge pairs one Telegram bot with one Orca bot, so `@ci_bot` can front your CI watcher and `@dev_bot` your coding assistant. Every bridge has its own token, access list, roles, language, proxy, group and voice settings, and they all run at once: a bridge that fails never stops the others.
- **A panel that follows your bot.** Click a bot in Orca's left sidebar and the Telegram panel shows only that bot's bridge, chats, logs and audit trail.
- **Roles for the people you let in.** Choose what each person or group may do (chat, start or switch chats, sync, automations) and give each role an extra prompt for the Orca bot, such as "read-only, plain Spanish".
- **Know who did what.** An Audit tab records who ran an automation, changed sync or chats, and who was refused, plus every access, role or token change made in the panel. Never message text.
- **Private chats and groups**: in a group the bot answers when called, or follows the conversation and joins in when it can help.
- **Voice messages**, transcribed with OpenRouter or OpenAI and answered as text.
- **Images and files both ways**: photos, spreadsheets, PDFs and other files reach the Orca bot as local files, and the Orca bot can send back charts, screenshots and documents; Markdown and tables come back formatted.
- **Calm long answers.** A long run shows "⏳ Working…" instead of silence, and a failure is one plain line, with **Details** for the owner and **Try again** only when it is safe.
- **Replies in the user's language**: English, Português, Español, 中文, or Auto per chat.
- **No server to run**: the plugin long-polls Telegram from inside Orca. No public IP, webhook or extra daemon.

## Features

- **Several bridges**: one Telegram bot per Orca bot (for example `@ci_bot` → `CIWatcher`, `@dev_bot` → `DevHelper`), each with its own token, access list, roles, language, proxy and on/off switch. The Telegram panel follows the bot selected in Orca's left sidebar and shows only that bot's bridge, chats, logs and audit trail
- **Always-on long polling** (`getUpdates`) inside Orca's worker (no public IP, webhook, or external daemon required)
- **Open or restricted access**: anyone on Telegram, or only the Telegram user and group IDs you list, with one-click **Allow** in the sidebar panel. See [Who can talk to the bot](#who-can-talk-to-the-bot)
- **Roles**: per bridge, which commands each person or group may use (private and group rights kept apart for `/new`, `/home`, `/bind`), which automations they may run, and an extra prompt for the Orca bot. Built in: Full access, Member, and Stranger for anyone on Telegram. Refusals are one plain line; each person's `/` menu and `/help` show only what their role allows. See [Roles](#roles)
- **Telegram groups**: Off, answers when called (`@yourbot` mention, reply to the bot, or a command for it), or follows the conversation and answers when called or when it can help. See [Use the bot in a group](#use-the-bot-in-a-group)
- **Reply language**: the bridge's own replies and `/` menu in English, Português (Brasil), Español or 中文, or **Auto**: each chat in its user's Telegram language (English until one is known), and the Orca bot asked to answer in the language of each message
- **Encrypted Bot Token storage** via `orca.secrets` (OS keyring)
- **HTTP proxy support** (`proxyUrl` or `HTTPS_PROXY` / `HTTP_PROXY`)
- **Per-chat Orca context binding** — keeps multi-turn conversation history in a dedicated Orca chat per Telegram chat and automatically tracks Orca bot renames by `botId`. The Orca chat is named after the Telegram chat, such as `telegram@drecchia` (a person's `@username`, else their name; a group's title), replacing Orca's automatic "Telegram: …" title after the first answer; a title set with `/rename` or in Orca is kept
- **Telegram → Orca images and files** — downloads compressed photos, image documents and any other file (spreadsheets, PDF, CSV, Office, text…, up to Telegram's 20 MB bot limit) locally and passes their path(s) and original names to the Orca bot (with optional caption); a larger file gets a plain reply instead of silence
- **Orca → Telegram images and documents** — the Orca bot attaches a file by writing `![caption](path or https URL)`; the plugin sends it as a photo or document
- **Voice messages**: per bridge, voice messages and audio files are transcribed with OpenRouter or OpenAI and reach the Orca bot as text
- **Optional two-way Orca-side sync** (`syncOrcaOutbound`) — optionally forwards messages you send directly in Orca (and bot replies) from bound chats back to Telegram. Orca's own automation prompts (reminders, deadlines, events, and scheduled runs of an automation that ran in that chat in the last 24 hours) stay in Orca; only the bot's answer goes. Like Orca, a bot answer ending in `NO_REPLY` sends nothing
- **Telegram `/` command menu** (`setMyCommands`, per role and per language) + **interactive inline buttons**: `/help`, `/new`, `/home`, `/bots`, `/chats`, `/bind`, `/rename`, `/sync`, `/automations`, `/run`, `/status`
- **Clean setup panel**: a bridge is shown by its bot's `@username`; the editor groups Connection, Who can talk, Roles, Groups and Features, with rare options under Advanced; **Save** closes the editor, and a failed save says why next to its buttons
- **Working line and plain errors**: after 20 seconds without an answer, a "⏳ Working…" line that is removed when the answer comes; failures in plain words ("This took too long", "Can't reach Orca right now"), with a **Details** button and a **Try again** button only when the message surely never reached the Orca bot. See [Long answers and errors](#long-answers-and-errors)
- **Audit trail**: an Audit tab of who did what (Telegram commands and buttons, role refusals, panel changes to access, roles and token), kept 90 days, with filters and CSV export; optionally one line in the group when someone changes its shared state. See [Audit trail](#audit-trail)
- **Rich Markdown + Table PNG rendering**:
  - Converts Markdown headings, bold, italic, strikethrough, blockquotes, task lists, links, and fenced code blocks to Telegram HTML
  - Renders standard Markdown tables (`| col |`) into crisp PNG images via Python Pillow (`sendPhoto`), automatically falling back to formatted text when Python/Pillow is not installed

## Requirements

- **Orca** `>= 1.4.248`
- **Optional (for table-to-PNG rendering)**: Python 3 with `Pillow` installed (`pip install pillow`)

## Install

Two ways work today: from this GitHub repository (CLI or Orca Settings) and from a local clone. The Orca catalog way is not available yet.

Already using `henryma96.telegram-bridge`? Read [Moving from henryma96.telegram-bridge](#moving-from-henryma96telegram-bridge) first.

| Way | Use it when |
| --- | --- |
| [From this GitHub repository](#from-this-github-repository-recommended) | You want to use the plugin. This is the normal way today. |
| [From the Orca catalog](#from-the-orca-catalog-not-available-yet) | Not available yet. This fork is not listed. |
| [From a local clone](#from-a-local-clone-development) | You want to change the code. |

The plugin key is `drecchia.telegram-bridge`. Orca uses the repository owner (`drecchia`) as the publisher.

**On Linux, Orca's CLI is `orca-ide`.** Plain `orca` there is usually the GNOME screen reader. Replace `orca` with `orca-ide` in every command in this README. On Windows and macOS the command is `orca`.

### From this GitHub repository (recommended)

Orca installs the newest `vX.Y.Z` tag of this repository and pins it to that exact commit:

```sh
orca plugin install drecchia/orca-telegram-bridge
```

To install one exact version, add its tag (see the repository tags):

```sh
orca plugin install drecchia/orca-telegram-bridge@vX.Y.Z
```

**Approve the plugin.** This plugin runs code, so the first run stops with `approval_required` (exit code `3`). Nothing is installed yet. Orca prints:

- what the plugin would be granted and why (its capabilities `storage:own`, `secrets:own`, `settings:own`, plus its panel and commands);
- the publisher (`drecchia`) and the source repository (`github.com/drecchia/orca-telegram-bridge`), because the plugin does not come from Orca's official catalog;
- the exact command to run again with `--approve <fingerprint>`.

Check the list. If you trust it, run the printed command. It looks like this:

```sh
orca plugin install drecchia/orca-telegram-bridge --approve <fingerprint>
```

The fingerprint is bound to this plugin, version, files and access. Installing a different version by hand needs a new fingerprint. Updates that ask for no new access keep the approval (see [Update](#update)).

Without the CLI: in Orca, open **Settings → Plugins**, choose **Add plugin**, then **From a Git URL…**. Paste `https://github.com/drecchia/orca-telegram-bridge#vX.Y.Z`, choose **Install**, review the access, then enable it.

### From the Orca catalog (not available yet)

When the plugin is listed on [orca.dev/plugins](https://orca.dev/plugins), you can install it by id:

```sh
orca plugin install drecchia.telegram-bridge
```

Today this does not work. This repository is a GitHub fork of [HenryMa96/orca-telegram-bridge](https://github.com/henryma96/orca-telegram-bridge), and the directory leaves forks out ([Add your plugin](https://orca.dev/plugins/add)). The current status is on [orca.dev/plugins/drecchia/orca-telegram-bridge](https://orca.dev/plugins/drecchia/orca-telegram-bridge). Use the GitHub install above. After listing, the approval step is the same. Existing GitHub installs keep updating from GitHub; you do not need to switch.

### From a local clone (development)

Load the working folder as a development plugin:

```sh
git clone https://github.com/drecchia/orca-telegram-bridge.git
cd orca-telegram-bridge
orca plugin dev load . --json
```

The first load also stops with `approval_required` (exit code `3`). Run it again with the printed fingerprint:

```sh
orca plugin dev load . --approve <fingerprint> --json
```

Orca reloads the plugin when its files change. Code edits run without a new approval. New access needs one. If Orca missed a change, reload by hand:

```sh
orca plugin dev reload . --json
```

To remove the development copy, run `orca plugin dev unload .`. For checks and releases, see [PUBLISHING.md](./PUBLISHING.md).

### Update

- GitHub install: run `orca plugin update drecchia.telegram-bridge`, or run the install command again with the new `@vX.Y.Z` tag. If the new version asks for more access, Orca stops with `approval_required` and keeps the running version. Run the printed `--approve <fingerprint>` command.
- Local clone: `git pull`, then `orca plugin dev reload . --json`.

### Moving from `henryma96.telegram-bridge`

The upstream plugin has the key `henryma96.telegram-bridge`. This fork has a different key, so Orca treats it as a different plugin. The bot token, settings and stored data do not carry over.

1. Remove the old plugin. If you installed it from GitHub or the catalog, run `orca plugin uninstall henryma96.telegram-bridge`. If you loaded a local folder (upstream's Setup step), run `orca plugin dev unload <that folder>`. Two copies that poll the same bot token conflict.
2. Install this fork (see above).
3. Do the [Setup](#setup) steps again.

## Setup

Do these steps after the plugin is installed and approved (it asks to read your workspaces, so the panel can follow the bot you select). Repeat them for each Orca bot you want on Telegram; each Orca bot has at most one bridge.

1. Click an Orca bot in Orca's left sidebar, then open the **Telegram** panel in the right sidebar. The panel follows the selected bot: **Setup**, **Chats**, **Logs** and **Audit** show only that bot's bridge. With a project or workspace selected instead, the panel only asks you to select a bot (plus any bridge whose Orca bot no longer exists, so you can still remove it). If Orca cannot tell the panel which bot is selected, it shows every bridge. The **TG** item in Orca's status bar shows all bridges' state (`TG: 2/2` = 2 of 2 active bridges connected); click it to open this panel.
2. A bot without a bridge shows **Add bridge**: click it. The new bridge talks only to this Orca bot; `/use` cannot switch it. A bridge is shown by its Telegram bot's `@username` ("New Telegram bot" until its token is checked). An update from 0.4.0 or older already has one bridge with your previous settings.
3. **Connection:** paste the `@BotFather` bot token. Each Telegram bot token can belong to one bridge only.
4. **Who can talk:** choose **Only these people and groups** and type the IDs, or **Anyone on Telegram**. See [Who can talk to the bot](#who-can-talk-to-the-bot).
5. Click **Save**, then **Test connection**. The **Active** switch on the bridge's card turns it on or off at once; no Save needed.
6. Optional: **Groups** (see [Use the bot in a group](#use-the-bot-in-a-group)), **Features** (voice messages, Orca-side sync) and **Advanced**, closed by default: the **Telegram reply language**, the reply timeout, an HTTP proxy (e.g. `http://127.0.0.1:7890`) and the transcription model. The reply language sets the bridge's own replies and command menu: **English**, **Português (Brasil)**, **Español** or **中文**, or **Auto (language of each message)**. With **Auto**, a chat starts in English. Once a message shows the sender's Telegram app language (Portuguese, Spanish or Chinese; any other counts as English), the chat keeps that language, also after a restart, for the bridge's replies and errors, for messages that do not show a language, and for Orca → Telegram sync; the `/` menu follows each person's app language. The Orca bot is asked to answer in the language the user wrote in, and in the chat's language when a message has no words (an image alone). With a fixed language, the Orca bot's answers keep the language the Orca bot writes in.

<p align="center">
  <img src="docs/images/bridge-editor.png" alt="The bridge editor: Connection with the saved bot token and the Orca bot it talks to, Who can talk with two listed IDs and their roles, the Roles section, Groups options and Features" width="420">
</p>

To remove a bridge, open its editor, click **Remove**, then **Confirm remove**. Orca forgets its token and its chats; its log entries stay in the Logs tab and its audit entries in the Audit tab.

Why not a connector inside Orca's **Bot settings → Connectors**? A plugin cannot add connectors there: Orca's connectors (Slack, Linear, GitHub, Google, Webhook) are built in. A native Telegram connector is requested upstream in [stablyai/orca#45959](https://github.com/stablyai/orca/issues/45959).

## Who can talk to the bot

Each bridge has its own **Who can talk** choice (Setup tab → the bridge's **Edit**). Access to one Telegram bot says nothing about another:

- **Anyone on Telegram: open to everyone.** Any Telegram user who finds your bot, and any group it is in, can use it. The panel shows an **Open to everyone** warning on the card.
- **Only these people and groups: restricted.** Only the listed IDs can use the bot. A user ID allows that person in private chats and in any group. A group ID (a negative number, e.g. `-1001234567890`) allows every member of that group. The list may be empty: then nobody can talk until you allow someone (see below).

Each listed person or group has a **role** (see [Roles](#roles)) that sets what they may do. With **Anyone on Telegram**, everyone not listed gets the **Stranger** role, which can chat but can never run automations, change sync or reach your Orca chats.

[Orca → Telegram sync](#features) works only with a restricted list. While the bot is open to everyone, sync is paused, so a stranger who binds one of your Orca chats does not receive what you write in Orca.

### Restrict access

1. Choose **Only these people and groups** and click **Save**. You may add IDs now (**Add person or group**, one row per ID, with a role) or leave the list empty.
2. Ask each person to send any message to the bot (in a group, mention the bot). Do the same yourself if you do not know your ID.
3. An unknown person gets one short reply with their Telegram ID (at most once a minute), and the panel shows a banner: `User <ID> messaged your bot but is not in the allowlist.` Click **Allow \<ID\>** to add them with the **Member** role. The banner shows only the latest unknown person. To give yourself more rights, change your role in **Edit**.
4. A group that is not on the list shows its own banner: `The bot is in group <ID> (<title>), which is not in the allowlist.` It shows when the bot is added to the group, or when any message arrives from it (a command too, and also in learning mode, which answers nobody). Click **Allow group \<ID\>** to let every member in with the **Member** role. The banner shows only the latest such group. It goes away once the group is listed or the bot leaves the group, and is hidden while groups are off. With privacy mode on, Telegram sends the bot only messages meant for it, so if no banner shows, send `/help@<bot username>` in the group (a plain `/help` may go to another bot).

Other ways to find an ID: the panel's **Chats** tab (`TG <ID> -> …`) while the bot is open, or a bot such as `@userinfobot`.

A saved ID shows the name the bot knows for it in the same field, for example `175844659 @ana_dev`: the person's `@username` (or first and last name), or the group's title. A saved ID cannot be edited; to change one, remove its row and add another. The bridge learns names from messages, and asks Telegram once when it connects and after **Save** for IDs that have none yet. Telegram answers only for people who have opened the bot and groups the bot is in; the others show the ID alone until they write. Only listed IDs are kept, on this computer.

Removing an ID stops the bot from answering that person or group, and stops sync to their chats. Choosing **Anyone on Telegram** opens the bot to everyone again.

### Roles

Each bridge has its own roles (Setup tab → the bridge's **Edit** → **Roles**). A role has:

- **What it may do**, one checkbox each: chat with the bot, `/status`, `/bots`, `/new`, `/home` and `/chats` + `/bind` (each separately **in private** and **in groups**, so a teammate can start a fresh private chat without resetting the group's shared chat), `/rename`, `/sync`, `/automations`, `/run`, and **See error details** (the [Details] button under a failed answer, in private chats). With `/run`, choose **All** automations or **Only these**. `/help` and `/status` always work, list only what the role may do, and show the bound chat and sync state only to roles that may change them; the `/` menu each person sees follows their role too.
- **An extra prompt for the Orca bot**, added to every message from people with that role, for example "Finance user: read-only, answer in plain Spanish". It is a hint to the bot, not a lock: only the checkboxes are enforced by the bridge. People never see it.

Three roles come built in: **Full access** (everything), **Member** (chat, `/status`, `/new` in their own private chat) and **Stranger** (for **Anyone on Telegram**; it can never get the risky commands). Add your own with **Add role**, or **Copy roles from** another bridge.

Which role applies: a listed person's own role, also in groups; a group's role for its members who are not listed; else **Member** (restricted) or **Stranger** (open). A refused command or button gets one plain line: "This isn't available for you. Ask the bot's owner."

After the update that brought roles, everyone already on the list keeps **Full access**, so nothing changes until you choose otherwise; the panel asks you to review their roles once.

<p align="center">
  <img src="docs/images/bridge-roles.png" alt="The Roles section of the bridge editor: Full access, Member and Stranger, with Member opened to show its permission checkboxes and the extra prompt for the Orca bot" width="420">
</p>

### Use the bot in a group

Groups are off for a new bridge. Choose per bridge in the Setup tab → the bridge's **Edit** → **Groups**. Each option says what the bot reads and when it answers. "Called" means an `@yourbot` mention, a reply to one of the bot's messages, or a command for it (`/help@yourbot`).

| Option | Reads | Answers |
|---|---|---|
| **Off** | nothing; it leaves any group it is added to (the Logs tab says so) | never |
| **Answers when called** | only messages that call it; other messages never reach the Orca bot | each message that calls it |
| **Follows the conversation, answers when called** | every message, as context | only when called |
| **Follows the conversation, joins in when useful** | every message | when called, and on its own when it can clearly help; otherwise it stays silent (`NO_REPLY`) |
| **Learns from the conversation, never answers** | every message, to learn from it as the Orca bot's `SOUL.md` says | never, not even when called |

**Learns from the conversation, never answers** posts nothing in the group: no answer, typing indicator, working line or error line. An `@mention` or a reply to the bot is read like any other line. Commands for the bot are not run and do not reach the Orca bot; buttons on older bot messages in the group do nothing. Orca-side sync skips the group's chat (private chats still sync). What the bot learns, and where it keeps it, is up to the Orca bot's `SOUL.md`.

The mention is removed before the text goes to the Orca bot. With the three options that read every message, each group message starts one Orca bot turn, so a busy group costs more. Messages that do not call the bot never get a typing indicator or an error line in the group; problems go to the Logs tab. These options work only with **Only these people and groups**; while the bridge is open to everyone, the bot reads only messages that call it (and nothing in learning mode), so strangers in a busy group cannot start an Orca run with every line.

A bridge updated from 0.4.0 or older starts with **Answers when called**, the behavior it had before. A bridge that used **All messages** and was last saved before 0.8.0 starts with **Follows the conversation, joins in when useful**, so it keeps answering in the group. A bridge saved on 0.8.0 keeps the reply choice it saved then.

**Post a line in the group when someone changes its shared chat, sync or runs an automation** (below the options, off by default) tells everyone in the group, for example "@joao started a new chat". See [Audit trail](#audit-trail).

<p align="center">
  <img src="docs/images/bridge-editor-groups.png" alt="The lower part of the bridge editor: the four Groups options, the group notice switch, Features (voice messages, transcription provider and key, Orca-side sync) and the opened Advanced section with reply language, reply timeout, HTTP proxy and transcription model" width="420">
</p>

Telegram decides two things that the plugin cannot change. Set them for the bot in `@BotFather`; after the bot has connected once, the bridge's editor warns under **Groups** when one of them blocks the option you chose:

- **Allow Groups?** (`/setjoingroups`): must be enabled, or Telegram refuses to add the bot to a group.
- **Privacy mode** (`/setprivacy`; [Telegram: privacy mode](https://core.telegram.org/bots/features#privacy-mode)): on by default. While it is on, the bot receives only messages meant for it, such as commands addressed to it and replies to its own messages: the **Follows the conversation** options do not work, and **Learns from the conversation** gets no ordinary group message (it runs no command and never posts). Choose **Disable**, then remove the bot from the group and add it again; Telegram applies the change only then. A bot that is a group admin receives every message either way.

Then:

1. Add the bot to the group in Telegram (group menu → **Add members**).
2. Talk to it as the **Groups** option allows.
3. To restrict access to this group, add the group's ID under **Only these people and groups**. When the bot is added to a group, the **Logs** tab shows its ID: `Added to group -100… (<title>): the bot is a member.`, with a privacy warning when privacy mode keeps messages from it. The ID also appears in the **Chats** tab (`TG -100… -> …`) after the bot handles a message there. In restricted mode, a blocked group message also logs it: `Blocked unauthorized Telegram user <ID> (…) in group -100…`.

In a group, everyone sees the bot's replies, and the whole group shares one Orca chat: `/new`, `/bind` and `/home` change it for everyone in that group.

## Voice messages

Orca bots run agent CLIs that read text, so the plugin transcribes voice messages first. Turn it on per bridge in the Setup tab → the bridge's **Edit**:

1. Switch on **Voice messages**.
2. Choose the **Transcription provider**:
   - **OpenRouter**: one key for several speech-to-text models; default model `openai/whisper-large-v3`. Key from [openrouter.ai/keys](https://openrouter.ai/keys).
   - **OpenAI**: default model `gpt-transcribe`. Key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. Optional: another **Transcription model** of that provider. Leave it empty for the default.
4. Paste the **Transcription API key** and click **Save**. Orca keeps it encrypted, like the bot token.

Then a voice message, or an audio file (mp3, m4a, ogg, wav, flac, webm), reaches the Orca bot as `[Voice message, transcribed] <text>`, after the caption if there is one. The bot answers the text; the transcript is not posted back to Telegram and never written to the logs.

- The audio goes to the chosen provider, which charges per minute of audio. Files over 20 MB are refused: Telegram does not let a bot download larger files.
- The bridge's HTTP proxy, when set, is used for the transcription too.
- With **Voice messages** off, or on without a key, the sender gets a short reply that voice messages are not enabled for this bot.
- If the transcription fails, the sender gets a short reply with the reason, and the Logs tab has the details.

## Images and files from the Orca bot

An Orca bot can only answer in text, so the plugin gives it a convention: to send an image or a file, the bot writes it on its own line as

```markdown
![CPU usage, last hour](C:\Users\me\AppData\Local\Temp\cpu.png)
```

The plugin tells the Orca bot about this in every message, takes those lines out of the reply, sends the text, then sends each file with its caption. It works for direct replies and for [Orca → Telegram sync](#features).

- **Images** (PNG, JPEG, GIF, WEBP) go as photos. The plugin checks the file's content, not only its extension. A photo Telegram refuses (too large or too long) goes again as a file.
- **Documents**: PDF, CSV, TSV, TXT, MD, XLSX, XLS, DOCX, DOC, PPTX, PPT, ODT, ODS, ODP.
- **https links** to images or documents: Telegram downloads them itself, so nothing leaves your computer.
- Limits from Telegram: photos up to 10 MB (5 MB by link), documents up to 50 MB (20 MB by link).
- A file that is missing, too large or not allowed is not sent; the chat gets one short line with the file name (never the full path) and the reason.

**Files from your computer are sent only when the bridge is restricted** to [Only these people and groups](#who-can-talk-to-the-bot). While the bot is open to everyone, a file reference gets a short "only when restricted" line instead, so a stranger cannot ask the bot for your files; https links still work. The same rule already applies to Orca → Telegram sync and to the group **Follows the conversation** options.

Even when restricted, the Orca bot reads files with your rights, and an allowed person can ask it for one. The plugin always refuses files in credential folders (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gcloud`) and `.env` files, even through a shortcut or link, and sends only the image and document types above. Allow only people you trust if the bot can see private documents.

## Long answers and errors

- **Working line**: when the Orca bot takes more than 20 seconds, the chat gets one "⏳ Working… 20s" message that counts up (edited, not repeated). It is removed as soon as the answer, or nothing (`NO_REPLY`), comes back. Group lines that did not call the bot never get one.
- **Plain errors**: a failed answer is one line in the chat's language, without technical text: the bot is still working and went past the wait time, Orca could not be reached on the computer, or something went wrong. The technical cause stays in the **Logs** tab.
- **[Details]**: in a private chat, people whose role has **See error details** can see the technical cause (tokens masked).
- **[Try again]**: shown only when the message surely never reached the Orca bot (the Orca command could not even start). Orca cannot cancel a running answer, so after a timeout or any later failure there is no Try again: the first run may still be going, and a second could repeat an action. Only the person who sent the message can tap it, within 30 minutes.

## Telegram Commands

Each command needs its permission in the sender's [role](#roles); `/help` always works and lists only the commands the role allows.

| Command | Description | Role permission |
| --- | --- | --- |
| `/help` | Show the current Orca bot, chat, sync status, and the commands you may use | always |
| `/new` | Reset this chat's binding and start a fresh Orca chat | `/new` in private, or in groups |
| `/home` | Bind this chat to the Orca bot's Home Chat | `/home` in private, or in groups |
| `/bots` | List the Orca bots on this computer | `/bots` |
| `/use <name>` | Say which Orca bot this Telegram bot is pinned to (it cannot be switched from Telegram) | `/bots` |
| `/chats` | List recent Orca chats with inline bind / new / home buttons | `/chats` and `/bind` in private, or in groups |
| `/bind <chatId>` | Bind this chat to an existing Orca chat | `/chats` and `/bind` in private, or in groups |
| `/rename <title>` | Rename the bound Orca chat | `/rename` |
| `/sync [on\|off]` | Toggle or set Orca → Telegram sync | `/sync` |
| `/automations` | List the Orca automations your role may run, with Run buttons | `/automations` (buttons need `/run`) |
| `/run <id>` | Run an Orca automation now | `/run` (all, or only the role's chosen automations) |
| `/status` | Show the Telegram bot, Orca bot, chat, sync and polling status | `/status` |

## Audit trail

The **Audit** tab (next to Logs) answers "who did what, and when": it follows the selected bot like Chats and Logs.

- **From Telegram**: `/run` and Run buttons (with the automation's name), `/sync`, `/new`, `/home`, `/bind`, `/chats` bindings and `/rename`, the [Try again] and [Details] buttons, and every command, button or message a role refused. Each entry has the time, the person (Telegram ID and @username), the chat, their role and the result (done or refused).
- **From the panel**: changes to who can talk, roles and assignments, the bot token (only that it changed, never its value), **Allow**, and bridges added or removed.
- **Never recorded**: message text, chat titles, tokens, keys or role prompts.
- Filter by action and result, and **Export** a CSV file. Entries are kept 90 days, at most 2,000 across bridges, and stay after a bridge is removed.
- **Group notice** (Edit → Groups, off by default): a group gets one line when someone changes its shared chat or sync, or runs an automation, for example "@joao started a new chat".

## Debugging

<p align="center">
  <img src="docs/images/logs-certificate-error.png" alt="The Logs tab with two warnings: voice messages not transcribed because the OpenRouter request failed with a self-signed certificate error" width="420">
</p>

The **Logs** tab answers "what went wrong"; the **Audit** tab answers "who did what" (see [Audit trail](#audit-trail)).

- The **Logs** tab lists the newest 40 of up to 200 stored entries. Filter by level (all, errors, warnings and errors, debug only). Entries with details expand to show the error context: Orca CLI args, exit code and stderr; Telegram method, HTTP status and description; chat ids, timings and the top of the stack.
- Turn on **Debug logging** in the Logs tab (or the `debugLogging` setting, off by default) to also record `debug` entries: Telegram and Orca CLI calls with timings, dispatch start/finish, sync ticks that forward something, config changes (field names only), poll loop start/stop/backoff and errors that were ignored before. Turn it off again when done; errors and warnings keep their details either way.
- Error `self-signed certificate in certificate chain`? See [Troubleshooting](#self-signed-certificate-in-certificate-chain).
- Every message and detail is redacted: the bot token and any `bot<digits>:<secret>` pattern become `bot<redacted>`. Message text from users and bots is never logged, only lengths and ids.
- For a bug report, click **Export logs**. It saves a text file with a diagnostics header (plugin version, platform, Node version, resolved `orca` CLI path, status, config without the token, bot and binding counts) and every stored entry with its details.

## Troubleshooting

### `self-signed certificate in certificate chain`

**What it means.** The Logs tab shows it as a warning (screenshot under [Debugging](#debugging)). Something between your computer and the service re-signs HTTPS with its own certificate: antivirus HTTPS scanning (Kaspersky, ESET, Avast, Bitdefender…), a VPN, or a corporate proxy. Your operating system (Windows, macOS or Linux) trusts that certificate, so your browser works, but the Node runtime inside Orca has its own certificate list and refuses it. The scanner may pick some sites only; with Kaspersky on Windows we saw `openrouter.ai` intercepted while `api.telegram.org` and `api.openai.com` were not.

**What the plugin does.**

- **Voice transcription** (OpenRouter, OpenAI) trusts your operating system's certificate store (Windows, macOS or Linux) as well as Node's, like a browser, so it works through the scanner. The transcription API key then passes through the scanner.
- **Telegram** keeps Node's own list on purpose, because every Telegram request carries the bot token. If the scanner intercepts `api.telegram.org`, the bridge stops with this error instead of handing the token to the scanner.

**Bypass: exclude the hosts from HTTPS scanning.** This fixes Telegram, and keeps the transcription key out of the scanner too. Exclude:

```text
api.telegram.org
openrouter.ai
api.openai.com
```

In **Kaspersky** Standard, Plus or Premium ([Kaspersky: encrypted connections settings](https://support.kaspersky.com/kaspersky-for-windows/21.28/157530)):

1. Open Kaspersky and click **Settings** (the gear at the bottom).
2. Go to **Security settings**, then click **Network settings** in the **Advanced settings** block.
3. Open **Encrypted connections scan** and click **Configure trusted addresses**.
4. Click **Add**, type `api.telegram.org`, click **Add**. Repeat for `openrouter.ai` and `api.openai.com`.

Other antivirus products call the same setting HTTPS scanning, SSL/TLS filtering or web protection exclusions. Behind a corporate proxy, ask IT to exclude these hosts from TLS inspection.

Then send the Telegram message or voice message again. The Logs tab shows the result.

### Telegram requests time out for one bridge

**Symptom.** Every Telegram request of one bridge (`getMe`, `getUpdates`) times out in the Logs tab, while other bridges keep working.

**Find out where it fails.** On the same computer, ask Telegram directly, first with a made-up token, then with the bridge's token. In a terminal (macOS, Linux, or Git Bash on Windows), `read -rs` takes the token without showing it or saving it in the shell history; paste it and press Enter:

```sh
curl -sS -m 40 -w "\nhttp=%{http_code} total=%{time_total}s\n" https://api.telegram.org/bot123456:fake/getMe
read -rs TOKEN
curl -sS -m 40 -w "\nhttp=%{http_code} total=%{time_total}s\n" "https://api.telegram.org/bot$TOKEN/getMe"
unset TOKEN
```

- **Both answer fast** (`401` for the fake one, `200` for yours): the path works now; restart the bridge with its **Active** switch and check the Logs tab.
- **The fake one answers fast, yours fails** (for example `502 Bad Gateway` after about 16 seconds): the network reaches Telegram, but Telegram's answer for that bot fails. Others have reported this for single bots in [tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api/issues), where it cleared on Telegram's side and a new token for the same bot did not help. You can wait, or create a new bot with `@BotFather` (`/newbot`) and paste its token into the bridge's editor; people must then open the new bot, and groups must add it again. When the old bot answers again, Telegram delivers the messages sent while it was down, all at once.
- **Both fail or hang**: the problem is between this computer and Telegram (network, proxy, VPN or antivirus); see the entry above and the bridge's HTTP proxy setting.

Never paste a bot token in a chat or a bug report; if you did, revoke it in `@BotFather` (`/mybots` → the bot → **API Token** → **Revoke current token**) and paste the new one in the editor.

## Develop & Release

To work on the code, use the [local clone install](#from-a-local-clone-development). [PUBLISHING.md](./PUBLISHING.md) is the full runbook: the pre-release audit, the checks (`orca plugin validate`, `test`, `check`, `release-entry`), tagging a `vX.Y.Z` release, and the catalog listing status.

## License

[MIT](./LICENSE)
