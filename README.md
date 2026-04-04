# paperclip-plugin-telegram (Animus Systems fork)

Forked from [mvanhorn/paperclip-plugin-telegram](https://github.com/mvanhorn/paperclip-plugin-telegram) v0.2.6.

## Fork changes

### DM chat with Ava

Send any message to the bot in a private chat and Ava responds — same CEO-personality board assistant as the Paperclip web UI chat, with full org context.

- Spawns Claude CLI directly (`claude --print --resume`) per DM
- Injects live org data: agents (with error status), open issues, completed issues, projects
- Searches MemOS for relevant org memories
- Session continuity via `--resume`
- Typing indicator while processing (5-30s response time)
- Issue creation: Ava can create Paperclip issues from conversation
- Exchanges stored in MemOS + Paperclip activity feed

### DM session history

- DM conversations saved to plugin state
- `/archive` command: archives current session, clears chat, starts fresh CLI session
- Auto-archive: sessions older than 24h archived on next message
- Archived sessions visible in the Paperclip web UI (History tab, marked with blue "TG" badge)
- Active Telegram session shown with green "LIVE" badge

### New commands

- `/routines` — shows guidance on checking routines (SDK limitation prevents direct access)
- `/archive` — archive current Ava chat session

### Deployment

This fork is deployed by copying dist files (not symlinked) due to ESM module resolution constraints in Docker:

```bash
# Build:
npm install
npm run build

# Deploy to Paperclip plugins:
cp -r dist/ /path/to/paperclip-data/appdata/.paperclip/plugins/node_modules/paperclip-plugin-telegram/dist/
cp package.json /path/to/paperclip-data/appdata/.paperclip/plugins/node_modules/paperclip-plugin-telegram/

# Update manifest in DB (if version changed):
# Run the manifest update SQL from the CEO Chat plugin README pattern

# Restart server
docker compose restart server
```

## BotFather commands

Paste into BotFather after `/setcommands`:

```
status - Company health: active agents, open issues
issues - List open issues (optionally by project)
agents - List agents with current status
routines - List active routines and their schedules
approve - Approve a pending request by ID
archive - Archive current chat session with Ava
help - Show available commands
connect - Link this chat to a Paperclip company
connect_topic - Map a project to a forum topic
acp - Manage agent sessions (spawn, status, cancel, close)
commands - Manage custom workflow commands
```

## All features

### From upstream
- Push notifications (issue created/done, approvals, agent errors, run lifecycle)
- Interactive approve/reject inline buttons
- Per-type chat routing (approvals, errors, escalation channels)
- Bot commands (`/status`, `/issues`, `/agents`, `/approve`, `/acp`, `/commands`, `/help`)
- HITL escalation with timeout and default actions
- Multi-agent group threads (up to 5 agents, @mention routing, handoff, discuss)
- Media-to-task pipeline (voice transcription, Brief Agent intake)
- Custom workflow commands
- Proactive agent suggestions (watch conditions)
- Reply routing (replies to bot messages create issue comments)
- Daily/bidaily/tridaily digest summaries
- Forum topic-to-project mapping

### Fork additions
- DM chat with Ava (direct Claude CLI, full org context, MemOS)
- Issue creation from Ava conversations
- `/archive` command with session history
- `/routines` command
- Telegram history visible in Paperclip web UI
- `projects.read` capability for project context

## Known limitations

- `ctx.http.fetch` blocks localhost/private IPs — can't call Paperclip API from plugin worker
- Routines have no SDK client — `/routines` command gives guidance instead of data
- Telegram and web UI use separate CLI sessions (cross-plugin state not accessible)
- Both write to MemOS and activity feed for unified org history

## License

MIT
