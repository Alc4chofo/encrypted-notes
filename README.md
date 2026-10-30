# encrypted-notes

Encrypted notes in a single HTML file. No dependencies, no build step, no server: open `index.html` in a browser and everything is encrypted and decrypted right there, with a master password that never leaves your machine. Your notes sync to a **private GitHub repo of your own**, which only ever stores ciphertext.

This repo holds the app only. It never contains anyone's notes, and nobody can sync into it: each person creates their own private repo and points their copy of the app there.

**[How it works](HOW-IT-WORKS.md)** explains the threat model, the cryptography, the file formats and the sync protocol in detail, with the function names to check each claim against the code.

## Setting it up

1. Create a new **private** GitHub repo for your vault, for example `notes`. Do not fork this one: GitHub makes forks of public repos public, and the app refuses to sync to a public repo.
2. Copy `index.html` into it and set your repo near the top of the script:

   ```js
   const OWNER = "YOUR_GITHUB_USER", REPO = "YOUR_PRIVATE_REPO", ...
   ```

3. Create a fine-grained token (GitHub Settings > Developer settings > Fine-grained tokens) with access to **that repo only** and the permission **Contents: read and write**.
4. Open `index.html` (a double click is enough). On first run, choose a master password (a strength meter shows a rough cracking time as you type), confirm it, and paste the token. The token is stored inside the encrypted vault, never in plain text.
5. Write notes. They autosave; **Save** or Ctrl+S forces a save. **Sync** (bottom left) merges with the repo, and **Lock** (Ctrl+L) forgets the decrypted vault until you type the password again.

On another computer, clone your private repo and open `index.html`: the synced vault is picked up from the folder, so only the master password is needed.

## Updating the app

Each copy of the app carries a build number (`APP_BUILD`, shown in **Settings**). When you press **Sync**, the app also looks at the `index.html` in your private repo, and if that one is a newer build it asks before touching anything: the dialog shows the new build, the date it was committed, who committed it and the commit message. **Update index.html** writes the new file over the one you opened (Chrome and Edge ask once for access to its folder; other browsers download it for you to put in place), and it takes effect when you reload. **Not now** keeps your current version and does not ask again until the file changes; **Settings > Check now** offers it again. Your notes sync either way.

To move your copy to a newer version of this app, put the new `index.html` in your private repo with your own `OWNER`/`REPO` line and push it; every device then gets the question on its next Sync. (A copy with the placeholder line also works: the app keeps its own repo setting when it installs it.) Copies older than the first build with updates need this one update by hand.

## Features

- **Notes and folders**: nested folders, drag and drop to reorder or move, colours, pinned notes at the top of the list, and a search over titles, note text and folder names. Censored text is never searched.
- **Rich text**: fonts, sizes, colours, highlight, links, numbered lists and tables with row and column controls. Undo and redo cover structural changes too, and each formatting change is a step of its own.
- **Right-click formatting**: right-click selected text for Cut, Copy, bold, italic, underline, strikethrough, censor, font, size, colour, highlight, alignment, link and clear formatting (inside a table, its row and column controls too). Without a selection, or with Shift held, you get the browser's own menu, with its spelling suggestions.
- **Custom colours**: the **+** in the colour palette opens a colour editor in the palette itself (a saturation and brightness square, a hue strip, a hex field and, in Chrome and Edge, an eyedropper). Colours you use are kept in the palette. If you have changed anything, clicking outside the palette or pressing Escape asks whether to stop editing first.
- **Paragraph alignment**: left, centre, right or justified, for the paragraph the cursor is in (or every paragraph a selection touches), not the whole note. Pressing Enter twice starts a new paragraph, back at the default left alignment. On an empty line, alignment applies to that line and the paragraph after it, never to anything above.
- **Censor**: works like bold. Switch it on and what you type is censored, switch it off and typing is normal again, or select text and press it to censor (or uncensor) just that. Bold, fonts, sizes and colours underneath are kept. In the app censored text is a black bar you can hover to read and keep editing; anything that leaves the app (PDF, print, design files, copy and drag) carries only the bar, never the text.
- **Pages**: a note can be a stack of real A4 sheets that paginate as you type, with designs (title, body and closing pages) you can import and export as `.design.json`.
- **PDF export**: a built-in PDF writer, so what you see on the sheets is what you get, with no browser metadata. A folder export writes the PDF plus a `files/` folder for its attachments. **Censored** text and images never reach the exported file: only a bar of roughly the same length does. Copying a selection that includes censored text puts plain text on the clipboard with each censored run as a row of blocks (`████`).
- **Attachments**: any file type up to 200 MB, inline or attached. Images are re-encoded on import to strip EXIF and GPS data; SVG and HTML are download-only and never rendered.
- **Sync**: a real merge, not last-write-wins. A genuine conflict keeps both versions as a "(conflict ...)" copy. Sync also offers newer versions of the app itself from your repo (see [Updating the app](#updating-the-app)).
- **Trash**: deleted notes stay for 30 days, read-only, and can be restored or purged.
- **Backups**: weekly and monthly encrypted backups, with a reminder at unlock when one is overdue (after 7 and 30 days by default, adjustable in **Settings**), plus a manual backup file you can keep anywhere.

## Security

- AES-256-GCM, with the key derived from the master password by PBKDF2-SHA256 at 1,200,000 iterations, a random salt and a fresh IV on every save.
- Attachments are encrypted with a separate random 256-bit key that lives inside the vault, and each file is bound to its own id, so files cannot be swapped by someone with write access to the repo.
- Browser storage only ever holds ciphertext. Titles, bodies, folder names, attachments and the token exist in the clear only in memory while unlocked.
- Brute-force guard: each password attempt costs 3 seconds, and after 10 failures the vault locks for 30 days.
- Private repos only: until `OWNER` and `REPO` are set the app sends nothing, and before its first request after the page opens it asks GitHub whether the repo is private. A public repo is refused before a single byte is uploaded, because anyone could download the encrypted vault from it and try passwords offline.
- Trade-off worth knowing: `index.html` loads `vault.enc.js` from its own folder with a script tag, which is what makes password-only unlock work on a fresh clone. Anyone who can write to your vault repo could therefore run code in the page, the same trust you already place in that repo for `index.html` itself. Keep it private and the token scoped to it.
- App updates come only from your own private repo, through the same private-repo check as everything else, and never install without your click. The dialog warns when the new file would sync with a different repo or no longer has the private-repo check, but it cannot tell good code from bad: accept an update only when you made that change yourself.
- Auto-lock: after 10 minutes without input the app saves and locks itself. **Settings** (bottom left) changes the delay or turns it off; the choice is kept per device.
- Forget the master password and nobody can decrypt the vault, you included.

## What never goes in this repo

Vault data: `vault.enc`, `vault.enc.js`, `media/`, `backup-weekly.enc.js`, `backup-monthly.enc.js` and any other `*.enc` file. `.gitignore` refuses them as a safety net.
