# paperclip-plugin-telegram (Animus Systems fork)

Forked from [mvanhorn/paperclip-plugin-telegram](https://github.com/mvanhorn/paperclip-plugin-telegram) v0.2.6.

## Fork changes

### DM routing to Ava (CEO Chat bridge)

When `enableInbound` is enabled and a private chat (DM) message arrives that isn't a command or reply-to-bot, it is routed to the Ava chat agent via ACP spawn events. This allows the board to chat with Ava directly from Telegram DMs.

- Creates a persistent DM session per chat ID
- Registers session in the sessions state for ACP output routing
- Sends typing indicator while Ava processes
- Emits `acp-spawn` event with `agentName: "Ava"` — the CEO Chat plugin listens and responds
- Responses routed back via `plugin.paperclip-plugin-acp.output` event

### Deployment

This fork is deployed by copying dist files (not symlinked) due to ESM module resolution constraints in Docker:

```bash
# After building:
npm run build

# Deploy to Paperclip plugins:
cp -r dist/ /path/to/paperclip-data/appdata/.paperclip/plugins/node_modules/paperclip-plugin-telegram/dist/
cp package.json /path/to/paperclip-data/appdata/.paperclip/plugins/node_modules/paperclip-plugin-telegram/

# Restart server
docker compose restart server
```

---

*Below is the original README from the upstream plugin.*

---

Bidirectional Telegram integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Telegram, receive bot commands, approve requests with inline buttons, gather community signals, run multi-agent sessions in threads, process media attachments, register custom commands, and deploy proactive agent suggestions.

Built on the Paperclip plugin SDK and the domain event bridge.

## Features

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
- **DM routing to Ava** (Animus Systems fork addition)

## License

MIT
