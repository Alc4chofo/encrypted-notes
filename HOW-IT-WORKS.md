# How encrypted-notes works

This document describes exactly what the app does with your data: the threat model, the cryptographic construction, the storage and sync formats, and the limits. Every claim names the function in `index.html` that implements it, so you can check it against the code. The file is about 9,600 lines of unminified JavaScript with no dependencies, so what you read is what runs.

## Contents

1. [Threat model](#1-threat-model)
2. [Why a single HTML file is enough](#2-why-a-single-html-file-is-enough)
3. [Cryptography](#3-cryptography)
4. [What is stored where](#4-what-is-stored-where)
5. [Unlocking, locking and the attempt limit](#5-unlocking-locking-and-the-attempt-limit)
6. [Sync protocol](#6-sync-protocol)
7. [How long would guessing your password take?](#7-how-long-would-guessing-your-password-take)
8. [What someone with access to your repo can and cannot do](#8-what-someone-with-access-to-your-repo-can-and-cannot-do)
9. [Displaying untrusted content safely](#9-displaying-untrusted-content-safely)
10. [Known limitations](#10-known-limitations)
11. [Checking it yourself](#11-checking-it-yourself)
12. [References](#12-references)

## 1. Threat model

**What is protected:** note titles and bodies, folder names, attachments and their file names, and the GitHub token the app syncs with.

**Who the protection is aimed at:**

| Adversary | Example | Goal of the design |
| --- | --- | --- |
| A1: has the ciphertext | a GitHub breach, a leaked repo, someone who copies the browser's storage from a laptop | learns nothing about the content, and can only guess passwords offline at a deliberately high cost |
| A2: can write to your vault repo | a stolen token or account | cannot read anything, and cannot change or swap notes or attachments without being detected |
| A3: controls your unlocked device | malware, a malicious browser extension, someone at the keyboard | **out of scope.** While the vault is unlocked, the plaintext is in memory and anything running with the page's privileges can read it |

**Not a goal:** hiding *that* you use the app, how big the vault is, or when you sync. Those are visible to anyone who can see the repo (section 8).

## 2. Why a single HTML file is enough

A browser already ships everything a password manager-style vault needs:

- **Cryptography:** the W3C Web Cryptography API (`crypto.subtle`) provides PBKDF2, AES-GCM, SHA-256 and a cryptographically secure random generator (`crypto.getRandomValues`). The implementations are the browser's own native code, not a JavaScript library. The API is only exposed in secure contexts, and both `https://` and `file://` pages qualify, which is why a double-clicked `index.html` works.
- **Local storage:** `localStorage` holds the sealed vault and some bookkeeping; IndexedDB holds the encrypted attachments (section 4).
- **Remote storage:** GitHub's REST API answers cross-origin requests (CORS), so a page can read and write files in a repo with nothing but `fetch()` and a token in the `Authorization` header.

There is no server, no build step, no package manager and no third-party script. The only host the code ever contacts is `https://api.github.com`, and only when you sync, back up, or open an attachment that is not cached yet.

**One wrinkle, and how it is solved.** A page opened from `file://` may not `fetch()` its sibling files, but it *may* load them with a `<script src>` tag. So every time the app pushes `vault.enc`, it also pushes `vault.enc.js`, which is the same ciphertext wrapped as a script:

```js
window.__VAULT__ = {"v":1,"iter":1200000,"salt":"...","iv":"...","data":"..."};
```

A fresh clone opened by double click therefore finds its vault before you type anything, and you only need the password. The backups use the same trick. The cost of this convenience is a trust boundary, explained in section 8.

## 3. Cryptography

### 3.1 Primitives

| Purpose | Primitive | Parameters | Where |
| --- | --- | --- | --- |
| Password to key | PBKDF2-HMAC-SHA256 (RFC 8018) | 1,200,000 iterations, 128-bit random salt, 256-bit output | `deriveKey`, `ITER` |
| Vault encryption | AES-256-GCM (NIST SP 800-38D) | 96-bit random IV per seal, 128-bit tag | `sealObject`, `openVault` |
| Attachment encryption | AES-256-GCM | separate random 256-bit key, 96-bit random IV per file, AAD = `"media:" + id` | `encryptMedia`, `decryptMedia` |
| Conflict tie-break | SHA-256 | over a canonical serialization of the note | `sha256Hex`, `resolveConflict` |
| All randomness | `crypto.getRandomValues` | browser CSPRNG | everywhere |

All keys are created as non-extractable `CryptoKey` objects: page code can use them but cannot read their bytes. The one exception is the attachment key, which has to travel between devices (section 3.4).

### 3.2 Deriving the key from the password

`deriveKey` imports the password as raw PBKDF2 key material and derives an AES-256-GCM key:

```
K = PBKDF2-HMAC-SHA256(password, salt, iterations = 1,200,000, length = 256 bits)
```

- The salt is 16 random bytes, fresh for every new vault and every re-key.
- The iteration count is stored in each sealed blob (`iter`), so vaults sealed by older versions (310,000 and 600,000 iterations) still open. When one is opened, it is re-keyed straight away with a fresh salt at the current count (the `iterUsed < ITER` branch of the unlock handler).
- A new vault requires a password of at least 8 characters. That is a floor, not a recommendation; see section 7.

**Why PBKDF2 and not scrypt or Argon2.** Memory-hard functions resist GPU attacks better, but the Web Crypto API does not offer them. Using one would mean shipping a JavaScript or WebAssembly implementation, which breaks the zero-dependency property this design depends on (section 11). Within that constraint the iteration count is set to twice OWASP's current recommendation for PBKDF2-HMAC-SHA256 (600,000).

### 3.3 Sealing the vault

All notes, folders, the trash, tombstones, designs, the attachment key ring and the GitHub token live in one JavaScript object, the vault. `sealObject` serializes it to JSON and encrypts it:

```
iv     = 12 random bytes
C || T = AES-256-GCM-Encrypt(K, iv, plaintext = JSON(vault))
blob   = {"v":1, "iter":1200000, "salt":b64(salt), "iv":b64(iv), "data":b64(C || T)}
```

That JSON blob is exactly what `vault.enc` contains, and what `localStorage["vault"]` holds.

- **Integrity:** the 128-bit GCM tag covers the whole vault. Any change to the ciphertext, or to the salt, IV or iteration count that produce the key and nonce, makes decryption fail as a whole. Nothing is ever partly parsed.
- **Nonce safety:** GCM breaks badly if an IV ever repeats under the same key, so every seal draws a fresh random 96-bit IV. NIST SP 800-38D caps a key at 2^32 encryptions with random IVs. In practice even a heavy user (100 saves a day for ten years, about 3.7 x 10^5 seals) has a chance of any IV repeating of about n^2 / 2^97, roughly 2^-60. The key also changes whenever the salt does.

### 3.4 Attachments

Attachments are not sealed under the password key, because that key depends on a per-device salt that changes on every re-key, so attachments would become unreadable on other devices or after an upgrade. Instead:

1. On first use, the vault gets a random 256-bit **attachment key** (`vault.mediaKey`). It is stored *inside* the encrypted vault, so it is exactly as protected as your notes.
2. Each file is encrypted on its own:

   ```
   iv     = 12 random bytes
   C || T = AES-256-GCM-Encrypt(mediaKey, iv, plaintext = file bytes, AAD = "media:" + id)
   stored = iv || C || T
   ```

   `id` is the attachment's random UUID. Binding it in as additional authenticated data means a file moved to another id fails authentication. Someone with write access to the repo cannot swap one attachment for another.
3. **Key ring:** two devices that each start a vault independently mint different attachment keys, and merging their vaults must keep both readable. The vault therefore carries a ring. One key is active for new files, chosen deterministically (the smallest base64 string) so every device converges on the same one, and the others stay in `vault.mediaKeysOld`. `decryptMedia` tries the whole ring, so nothing ever becomes undecryptable.
4. **Authenticate before storing:** downloaded files are repo-controlled bytes. `getMedia` checks the GCM tag first and only then stores the file in IndexedDB, so a corrupted or tampered download never replaces a good local copy.
5. **Large files:** to stay well inside GitHub's per-file and per-request limits, a file larger than 20 MiB is uploaded as `media/<id>.p0 ... media/<id>.pN` plus a small manifest at `media/<id>`:

   ```
   notes-chunks-v1:{"parts":N,"total":<bytes>}
   ```

   The parts go up first and the manifest last, so an interrupted upload leaves no manifest and the next sync retries the whole set. On download the parts are joined and the single GCM tag authenticates the whole reassembled ciphertext. The manifest is plaintext and repo-controlled, so its part count is bounded by what the app could ever have written (200 MiB / 20 MiB), which stops a tampered manifest from triggering unbounded downloads.
6. **Metadata scrubbing:** JPEG, PNG and WebP images are re-encoded through a canvas when they are attached (`stripImageMetadata`), which removes EXIF data such as GPS coordinates and camera serial numbers before anything is encrypted.

## 4. What is stored where

### In your private repo

| Path | Content |
| --- | --- |
| `vault.enc` | the sealed vault blob (section 3.3) |
| `vault.enc.js` | the same blob as `window.__VAULT__ = ...;` (section 2) |
| `media/<uuid>` | one encrypted attachment, `iv \|\| ciphertext \|\| tag`, or a chunk manifest |
| `media/<uuid>.p<n>` | chunk parts of a large attachment |
| `backup-weekly.enc.js`, `backup-monthly.enc.js` | `window.__BACKUP_WEEKLY__ = {"at": <ms>, "data": "<sealed vault>"};` (and the monthly equivalent) |

Commit messages are fixed strings (`sync`, `media`, `purge`, `weekly backup`, `monthly backup`). They say nothing about content.

### In the browser

| Store | Key | Content |
| --- | --- | --- |
| `localStorage` | `vault` | the sealed vault blob |
| `localStorage` | `vault.prev`, `vault.prevAt` | a sealed snapshot taken before the last merge, for recovery |
| `localStorage` | `syncMeta` | random ids, timestamps and file hashes from the last sync. No titles, no bodies |
| `localStorage` | `authGuard` | the failed-attempt counter (section 5) |
| `localStorage` | `backupMeta`, `pullBanner`, UI preferences | timestamps, counts, colours, which sections are collapsed |
| IndexedDB `notes-media` | `<uuid>` | encrypted attachment records `{id, bytes: iv \|\| ciphertext \|\| tag}` |
| IndexedDB `notes-media` | `__authGuard__`, `__notesDir__` | the second copy of the attempt counter, and the folder handle backups are written to |

Plaintext exists only in memory while the vault is unlocked: the JavaScript heap, the rendered page, and temporary `blob:` URLs for attachments you open.

## 5. Unlocking, locking and the attempt limit

**Unlocking** waits a fixed 3 seconds, then derives the key (about a second or more, depending on the machine) and decrypts. Only a genuine decryption failure counts as a failed attempt; a typo in the confirm field on first run does not.

**The attempt limit** (`MAX_TRIES`, `LOCK_MS`): after 10 failures the vault refuses to unlock for 30 days. The counter is kept in two independent stores, `localStorage` and IndexedDB. They are merged field by field with the most restrictive value winning, so clearing one store or opening a second copy of the page does not reset it. The latest time ever observed is recorded too: a clock moved backwards while locked is treated as tampering, and the vault stays shut.

**What the limit is not.** It is a client-side control. It stops casual guessing on your own machine, but someone who copies `vault.enc` elsewhere never runs this code. Against that attacker only the key-derivation cost and your password's entropy matter (section 7). The code says so in its own comments, and so does this document.

**Locking** (`lockApp`, or Ctrl+L) drops the vault object, the key, the password, the attachment key ring and the undo history (which holds snapshots of notes). It revokes every decrypted `blob:` URL and clears every rendered panel that could hold titles or a typed token. It also bumps the counters that in-flight decryptions check, so an attachment still decrypting at the moment of locking cannot paint itself over the lock screen afterwards.

## 6. Sync protocol

**Transport:** the GitHub REST "repository contents" API, authenticated with your fine-grained token. Every write carries the file's current blob SHA, read just before. If anything wrote to the file in between, GitHub rejects the write with 409 Conflict, and the app re-runs the *whole* sync once: fresh read, fresh merge, fresh seal (`runSync`). It never re-sends the old content with an updated SHA, which would overwrite the other device's changes. If the second attempt conflicts too, it stops and asks you to press Sync again.

**Repo guard** (`ensurePrivateRepo`), checked before *any* request leaves the page:

1. `OWNER` and `REPO` must have been changed from the placeholders this repo ships with. Otherwise sync is off and nothing is sent.
2. `GET /repos/{owner}/{repo}` must answer `"private": true`. A public repo is refused before anything is uploaded or downloaded, because anyone could then copy the vault and start guessing offline. This also covers forks of this repository, which GitHub always makes public.

**One sync pass** (`syncOnce`):

1. **Read** `vault.enc` and its SHA. If the SHA equals the one recorded at the last sync, the remote has not changed and only local changes need pushing.
2. **Decrypt the remote** with the master password. If it cannot be decrypted (a different password, or not this vault), the sync **stops**: the app never overwrites a vault it cannot read. Replacing it takes an explicit, confirmed "Overwrite remote".
3. **Merge** (`mergeVaults`), object by object (notes, folders, trash entries, designs):
   - an object present on only one side is kept;
   - permanent deletions travel as tombstones (`vault.purged`, id to time), kept for 90 days;
   - if the same note changed on both sides since the last common sync, the newer `mtime` wins, ties go to the larger SHA-256 of its canonical content, and the losing version is kept as a "(conflict ...)" copy. The copy's id is derived from the inputs, never random, so two devices resolving the same conflict produce the *same* copy and do not fork twice;
   - the outcome does not depend on which device runs the merge, so devices converge.
4. **Seal and write** the merged vault with the SHA from step 1, then update `vault.enc.js`.
5. **Attachments:** upload local files the repo does not have, download referenced files this device lacks (authenticated before storing), and delete files whose tombstone says nothing references them any more.

A sealed snapshot of the pre-merge vault is kept locally (`vault.prev`), and a merge that would replace local edits never synced before asks for confirmation first.

## 7. How long would guessing your password take?

An attacker who has `vault.enc` can test passwords offline as fast as their hardware allows. Each guess costs one full PBKDF2 derivation:

- With 1,200,000 iterations and a 256-bit output (exactly one SHA-256 block), PBKDF2 performs 1.2 x 10^6 HMAC-SHA256 evaluations. Optimised crackers precompute the HMAC inner and outer pads, which leaves 2 SHA-256 compression calls per HMAC, so about **2.4 x 10^6 compressions per guess**.
- Assume a high-end GPU sustains about **2 x 10^10 SHA-256 compressions per second**, the order of magnitude published cracking benchmarks report for current consumer cards. That gives about **8 x 10^3 guesses per second per GPU**.

Expected time to find a *randomly generated* password, which on average means searching half the space:

| Password | Entropy | 1 GPU | 1,000 GPUs |
| --- | --- | --- | --- |
| 8 random lowercase letters | 37.6 bits | about 5 months | about 3.5 hours |
| 4 random diceware words | 51.7 bits | about 7,000 years | about 7 years |
| 5 random diceware words | 64.6 bits | about 54 million years | about 54,000 years |
| 12 random printable characters | 78.7 bits | about 9 x 10^11 years | about 9 x 10^8 years |

(Diceware words are drawn from a 7,776-word list, giving 12.9 bits each.)

These figures hold only for passwords chosen at random. A human-chosen password has far less entropy than its length suggests, and cracking tools try dictionary words, names, dates and common patterns first. **The password is the security of this system.** Use five or more random words, or a password manager's generator.

## 8. What someone with access to your repo can and cannot do

**With read access** (adversary A1), they can see:

- that the repo exists, and the approximate size of the vault and of each attachment;
- how many attachments there are, and when you synced or backed up (commit history and timestamps);
- the `at` field of each backup, deliberately left in plaintext so the lock screen can show a backup's age before unlocking.

They cannot see any title, body, folder name, file name, or the token. Every one of those exists in the repo only as AES-256-GCM ciphertext.

**With write access** (adversary A2), they cannot:

- read anything (same as above);
- change a note or attachment undetectably: any modification fails the GCM tag;
- substitute one attachment for another: the id is bound in as AAD.

They can:

- **deny service:** delete files, or corrupt them so they no longer open. This is unavoidable for any storage someone else controls, which is what backups are for;
- **replay an older vault** they saw earlier. The merge treats it as an old remote state and keeps every local change, so it cannot erase newer data on a device that already has it;
- **run code in your page.** This is the important one. The page executes `vault.enc.js` with a script tag (section 2), and a repo clone also contains `index.html` itself, so someone who can write to the repo can change the code you run and capture your password on the next unlock. Ciphertext integrity cannot protect against a modified program.

That last point is why the setup asks for a **private** repo and a token scoped to **that repo only**, and why the app refuses to sync with a public one. To check that your copy of the app is genuine, diff it against this repository: the only difference should be the `OWNER`/`REPO` line.

## 9. Displaying untrusted content safely

Every input path into the vault goes through AES-GCM authenticated decryption, so injecting content into your notes requires your password in the first place. The rendering rules are a second layer, for content you paste or import:

- **Note bodies** are stored as HTML that has passed an allowlist sanitizer (`sanitizeBodyFragment`). Input is parsed into an inert `<template>`, where nothing loads or runs, and only allowed elements are rebuilt: bold, italic, underline, strikethrough, spans, blocks, lists, tables and links. The `style` attribute is rebuilt declaration by declaration from an allowlist (`sanitizeStyle`); anything containing `url(`, parentheses or at-rules is dropped. Images and files are referenced only by validated id, never by URL.
- **Links** must start with `http://`, `https://`, `mailto:` or `tel:` (`safeHref`), so `javascript:`, `data:` and `blob:` links are impossible, and every link opens with `rel="noopener noreferrer"`.
- **Attachments** render only where it is safe: images (except SVG) in `<img>`, video in `<video>`, PDF in the browser's own viewer via a `blob:` URL, plain text as text. SVG, HTML and everything else are download-only and never rendered, because active content running in the page's origin could read the decrypted vault.
- **Imported designs** (`*.design.json`) are treated as untrusted files and go through the same sanitizer.
- **PDF export** uses the app's own PDF writer (`buildNotePdf`). It writes no `/Info` dictionary, no document ID, no timestamps and no producer string. Censored text is replaced by a box whose width depends only on a coarse length bucket, so its glyph widths do not leak; censored images are never even decrypted for export.

## 10. Known limitations

- **No idle auto-lock.** An unlocked vault stays unlocked until you lock it, close it or reload it.
- **No protection on a compromised device** (adversary A3): malware or a browser extension with access to the page can read anything you can see.
- **Metadata is visible** to anyone who can read the repo: sizes, counts and timing (section 8).
- **Code integrity depends on the repo** (section 8). Keep it private and keep the token scoped.
- **PBKDF2 is not memory-hard.** It is the strongest function the Web Crypto API offers natively, and the iteration count is set high to compensate, but a long random password is still essential (section 7).
- **The attempt limit is client-side** and does nothing against an offline copy (section 5).
- **No password recovery.** Without the master password nobody can decrypt the vault, the author included.

## 11. Checking it yourself

The design deliberately makes auditing practical: one file, no dependencies, no build, no minification.

```bash
# Every remote host the code can contact (expect https://api.github.com, plus example.com as a link placeholder):
grep -oE "https?://[a-zA-Z0-9.-]+" index.html | sort -u

# Every use of the Web Crypto API:
grep -n "crypto\.subtle\|getRandomValues" index.html

# The key-derivation cost:
grep -n "const ITER" index.html
```

Then open the browser's developer tools on the Network tab: no request is made until you press Sync, make a backup or open an uncached attachment, and every request goes to `api.github.com` for the repo you configured.

## 12. References

- W3C, *Web Cryptography API*. https://www.w3.org/TR/WebCryptoAPI/
- NIST SP 800-38D, *Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC*, 2007.
- NIST SP 800-132, *Recommendation for Password-Based Key Derivation*, 2010.
- RFC 8018, *PKCS #5: Password-Based Cryptography Specification Version 2.1*, 2017.
- OWASP, *Password Storage Cheat Sheet* (PBKDF2-HMAC-SHA256 iteration guidance).
- EFF, *Large wordlist for passphrases* (7,776 words).
- GitHub REST API, *Repository contents* (writes are conditional on the file's current blob SHA).
