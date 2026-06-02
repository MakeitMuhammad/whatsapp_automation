# WhatsApp Broadcast Manager

A small local web app to:
- import/maintain contacts (manual, CSV, or synced from WhatsApp)
- create **tool-only** groups (not WhatsApp chat groups)
- broadcast a message to a selected group with a **random delay range** between each message

## Requirements

- **Windows 10/11**
- **Node.js (LTS recommended)**: install from [nodejs.org](https://nodejs.org/)
- A WhatsApp account on your phone (to scan the QR)

## Install & run (Windows)

1. Download the project (one of the options):
   - **Git**:
     - `git clone https://github.com/MakeitMuhammad/whatsapp_automation`
     - `cd "whatsapp_automation"`
   - Or download ZIP from GitHub and extract it, then open the folder in a terminal.

2. Install dependencies:

```powershell
cd "C:\path\to\whatsapp tool"
npm install
```

3. Start the server:

```powershell
npm start
```

4. Open the app in your browser:
- Go to `http://localhost:3000`

5. Link WhatsApp:
- The page will show a QR code.
- On your phone: **WhatsApp → Linked devices → Link a device** → scan the QR.

## First-time usage

### Sync contacts from WhatsApp
- Click **Sync from WhatsApp** (Contacts tab).
- This will store synced contacts into `data/contacts.json`.

### Import contacts via CSV
- Click **Import CSV**
- CSV must include headers: **Name**, **Phone**
- Phone can include symbols/spaces; the app will keep digits only.

Example:

```csv
Name,Phone
John Doe,+1 (555) 111-2222
```

### Create tool groups
- Go to **Groups** tab → **Create group**
- Search contacts, check the members you want, name the group, and save.

> Groups in this tool are stored in `data/groups.json` and are **not** WhatsApp chat groups.

## Sending messages

1. Go to **Groups** tab and click **Select** on a group.
2. Go to **Send** tab.
3. Type your message.
4. Pick a delay range (example: **10-15 seconds**).
5. Click **Send to group**.

### Random delay ranges
The selected delay range is applied **between each message**, and a new random delay is chosen every time (example: 12.3s, then 10.8s, then 14.7s...).

## Maintenance buttons (Contacts tab)

### Clear cache
- Clears `.wwebjs_cache` (WhatsApp Web bundle cache).
- **After clearing cache you must restart the server** (`npm start`) before syncing again.

### Clear synced contacts
- Removes all contacts imported from WhatsApp (`fromWhatsApp: true`).
- Keeps manual/CSV contacts.
- Also removes those contacts from any tool groups.

## Files / data

- `data/contacts.json`: contacts list (manual + CSV + WhatsApp-synced)
- `data/groups.json`: **tool groups only**
- `data/history.json`: last send history

## Troubleshooting

### QR never shows / WhatsApp keeps disconnecting
- Stop the server (`Ctrl+C`) and run `npm start` again.
- Try **Clear cache** then restart server and link again.

### Port already in use
- Close any other process using port `3000`, then run `npm start` again.

# whatsapp_automation
