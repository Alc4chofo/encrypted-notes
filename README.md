# encrypted-notes

Encrypted notes in a plain web page: `index.html`, its stylesheets and its scripts. No dependencies, no build step, no server: open `index.html` in a browser and everything is encrypted and decrypted right there, with a master password that never leaves your machine. Your notes sync to a **private GitHub repo of your own**, which only ever stores ciphertext.

This repo holds the app only. It never contains anyone's notes, and nobody can sync into it: each person creates their own private repo and points their copy of the app there.

**[How it works](HOW-IT-WORKS.md)** explains the threat model, the cryptography, the file formats and the sync protocol in detail, with the function names to check each claim against the code.

## Setting it up

1. Create a new **private** GitHub repo for your vault, for example `notes`. Do not fork this one: GitHub makes forks of public repos public, and the app refuses to sync to a public repo.
2. Copy the app into it: `index.html`, `config.js` and the `css` and `js` folders. Then set your repo in `config.js`, the one file you edit:

   ```js
   window.NOTES_CONFIG = { owner: "YOUR_GITHUB_USER", repo: "YOUR_PRIVATE_REPO" };
   ```

   Just the names, not a link: `owner` is your GitHub user name and `repo` the private repo's name.

3. Create a fine-grained token (GitHub Settings > Developer settings > Fine-grained tokens) with access to **that repo only** and the permission **Contents: read and write**.
4. Open `index.html` (a double click is enough). On first run, name your vault, choose a master password (a strength meter shows a rough cracking time as you type), confirm it, and paste the token. The token is stored inside the encrypted vault, never in plain text. The vault gets a folder of its own next to `index.html`, named after it (Chrome and Edge ask once for access to the app's folder), and syncs to the same folder in your repo.
5. Write notes. They autosave; **Save** or Ctrl+S forces a save. **Sync** (bottom left) merges with the repo, and **Lock** (Ctrl+L) forgets the decrypted vault until you type the password again.

On another computer, clone your private repo, open `index.html`, press **Other vault** and pick your vault: only the master password is needed. Chrome and Edge ask once for access to the app's folder to list its vaults; in other browsers, open the vault's `vault.enc.js` with **From a file...** and give it the same name.

## Updating the app

Each copy of the app carries a build number (`APP_BUILD` in `js/version.js`, shown in **Settings**); the version at the bottom left of the lock screen (`APP_VERSION`) is only a name for people. When you press **Sync**, the app also looks at `js/version.js` in your private repo, and if that is a newer build it asks before touching anything: the dialog shows the new build, the date it was committed, who committed it and the commit message. **Update the app** replaces `index.html` and the `css` and `js` folders with the new build, every file taken from that one commit and checked before it is offered (Chrome and Edge ask once for access to the app's folder; other browsers download the build as one ZIP for you to unpack over it), and it takes effect when you reload. `config.js` is never replaced, so your repo setting stays. **Not now** keeps your current version and does not ask again until the app changes; **Settings > Check now** offers it again. Your notes sync either way.

To move your copy to a newer version of this app, put its files (everything but `config.js`) in your private repo and push them; every device then gets the question on its next Sync.

Copies from before the app was split into files (build 2026-11-03.4 and older) cannot install the new layout themselves, and never offer it. Update each of them by hand once: put the new files in the app's folder, replacing `index.html`, and set your repo in `config.js`. From then on, updates arrive through Sync again.

## How the code is laid out

- `index.html`: the page, and the list of files it loads, in order.
- `config.js`: your repo. The only file you edit, and the only one an update leaves alone.
- `css/`: the look, by area (`base`, `lock`, `sidebar`, `editor`, `dialogs`).
- `js/`: the code, one file per part of the app: `core.js` holds the vault key and shared state, `sync.js` talks to GitHub behind the private-repo check, `merge.js` merges two vaults, `updates.js` offers app updates, `lock.js` runs the lock screen, `vaults.js` keeps each vault in its own folder, `i18n.js` holds the translations, and so on. Each file starts with a line saying what it does.
- `js/version.js`: the build number, and the list of every app file, which is what an update installs.

The scripts are plain scripts loaded in order, not JavaScript modules, because browsers refuse modules in a page opened from a file and the app has to run from a double click. Each one may use what the files before it define.

## Features

- **Notes and folders**: nested folders, drag and drop to reorder or move, colours, pinned notes at the top of the list, and a search over titles, note text and folder names. Censored text is never searched.
- **Vaults**: several vaults side by side, each in a folder of its own next to `index.html` (its `vault.enc`, `vault.enc.js`, backups and encrypted `media/`) and in the same folder in your repo. The lock screen says which vault it opens and when it last changed; **Other vault** switches and **New vault** makes another. A vault from before folders opens as "Main" and offers to move into `Main/`: one commit in the repo, which other devices follow on their next Sync. Update the app on those devices first, or an older copy puts the vault back at the top.
- **Languages**: English, German and Spanish, chosen at the top of the lock screen and kept per device. The names you give notes, folders, pages and vaults are never translated.
- **Rich text**: fonts, sizes, colours, highlight, links, numbered lists and tables with row and column controls. Undo and redo cover structural changes too, and each formatting change is a step of its own.
- **Right-click formatting**: right-click selected text for Cut, Copy, bold, italic, underline, strikethrough, censor, font, size, colour, highlight, alignment, link and clear formatting (inside a table, its row and column controls too). Without a selection, or with Shift held, you get the browser's own menu, with its spelling suggestions.
- **Custom colours**: the **+** in the colour palette opens a colour editor in the palette itself (a saturation and brightness square, a hue strip, a hex field and, in Chrome and Edge, an eyedropper). Colours you use are kept in the palette. If you have changed anything, clicking outside the palette or pressing Escape asks whether to stop editing first.
- **Paragraph alignment**: left, centre, right or justified, for the paragraph the cursor is in (or every paragraph a selection touches), not the whole note. Pressing Enter twice starts a new paragraph, back at the default left alignment. On an empty line, alignment applies to that line and the paragraph after it, never to anything above.
- **Censor**: works like bold. Switch it on and what you type is censored, switch it off and typing is normal again, or select text and press it to censor (or uncensor) just that. Bold, fonts, sizes and colours underneath are kept. In the app censored text is a black bar you can hover to read and keep editing, and the spell checker never marks it. Anything that leaves the app (PDF, print, design files, copy and drag) carries only the bar, never the text; copied, cut or dragged censored text that you paste or drop back into a note comes back censored.
- **Pages**: a note can be a stack of real A4 sheets that paginate as you type, with designs (title, body and closing pages) you can import and export as `.design.json`. Applying a design keeps the note: its writing goes where the design says `{content}`, between the design's title and closing pages.
- **PDF export**: a built-in PDF writer, so what you see on the sheets is what you get, with no browser metadata. A folder export writes the PDF plus a `files/` folder for its attachments. **Censored** text and images never reach the exported file: only a bar of roughly the same length does. Copying a selection that includes censored text, from a note or the second screen's reference pane, puts plain text on the clipboard with each censored run as a row of blocks (`████`).
- **Attachments**: any file type up to 200 MB, inline or attached. Images are re-encoded on import to strip EXIF and GPS data; SVG and HTML are download-only and never rendered.
- **Sync**: a real merge, not last-write-wins. A genuine conflict keeps both versions as a "(conflict ...)" copy. Sync also offers newer versions of the app itself from your repo (see [Updating the app](#updating-the-app)). Everything not synced yet is listed in its own section above the trash, each item under its folder path.
- **Trash**: deleted notes stay for 30 days, read-only, and can be restored or purged.
- **Lock screen background**: put a video named `lock-background.mp4` or `lock-background.webm` next to `index.html` and it plays, muted, behind the lock screen (still, on its first frame, if your system asks for reduced motion). It does not react to the mouse, and every piece of text and every button on the lock screen sits on a dark backing of its own size, so it stays readable over the video. **Settings** says which file it found, or exactly where to put one. The app never syncs it: copy it onto each computer, or commit it to your own private repo so a clone brings it along (this repo's `.gitignore` keeps it out of the public one).
- **Backups**: weekly and monthly encrypted backups, with a reminder at unlock when one is overdue (after 7 and 30 days by default, adjustable in **Settings**), plus a manual backup file you can keep anywhere.

## Security

- AES-256-GCM, with the key derived from the master password by PBKDF2-SHA256 at 1,200,000 iterations, a random salt and a fresh IV on every save.
- Attachments are encrypted with a separate random 256-bit key that lives inside the vault, and each file is bound to its own id, so files cannot be swapped by someone with write access to the repo.
- Browser storage holds only ciphertext, apart from the names of your vaults and when each last changed. Titles, bodies, folder names, attachments and the token exist in the clear only in memory while unlocked.
- A vault's name is also its folder's name, next to `index.html` and in your repo, so it is not encrypted: pick names that give nothing away. Each `vault.enc.js` also carries the time of the last save in plain text, so the lock screen can show it before unlocking, the same way a backup's age always could.
- Brute-force guard: each password attempt costs 3 seconds, and after 10 failures the vault locks for 30 days.
- Private repos only: until `config.js` names your repo the app sends nothing (a missing `config.js`, or a value that cannot be a GitHub name, such as a pasted link, counts as not set), and before its first request after the page opens it asks GitHub whether the repo is private. A public repo is refused before a single byte is uploaded, because anyone could download the encrypted vault from it and try passwords offline.
- Trade-off worth knowing: the page loads the vault's `vault.enc.js` from the vault's folder with a script tag, which is what makes password-only unlock work on a fresh clone. Anyone who can write to your vault repo could therefore run code in the page, the same trust you already place in that repo for the app's own files. Keep it private and the token scoped to it.
- App updates come only from your own private repo, through the same private-repo check as everything else, and never install without your click. Every file must match the id git gave it in that commit, so a damaged download is never installed, and an update can only write `index.html` and files in `css/` and `js/`. The dialog warns when the new files would no longer take the repo from `config.js` or no longer have the private-repo check, but it cannot tell good code from bad: accept an update only when you made that change yourself.
- Auto-lock: after 10 minutes without input the app saves and locks itself. **Settings** (bottom left) changes the delay or turns it off; the choice is kept per device.
- Forget the master password and nobody can decrypt the vault, you included.

## What never goes in this repo

Vault data: every vault's folder and what is in it (`vault.enc`, `vault.enc.js`, `media/`, `backup-weekly.enc.js`, `backup-monthly.enc.js`), and any other `*.enc` file. `.gitignore` refuses those files at any depth as a safety net.
